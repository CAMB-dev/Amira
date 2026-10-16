import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { SPAWN_TEST_TIMEOUT_MS } from "../../../scripts/spawn-test.ts"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"
import { finishWorker, startWorker, waitFor } from "./session-ownership-worker.ts"

async function bounded<T>(promise: Promise<T>, label = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`ownership regression timed out: ${label}`)), 5000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

for (const timing of ["before turns", "after turns", "deleted origin", "foreign lease"] as const) {
  test(
    `late aborted consultation usage respects session ownership: ${timing}`,
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "amira-late-ownership-"))
      const opened = Promise.withResolvers<void>()
      const terminalReady = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const charged = Promise.withResolvers<void>()
      const mock = createMockDialect([
        { toolCalls: [{ name: "read", args: {} }], usage: { cost: 1 } },
        { text: "APPROVE", usage: { cost: 3 }, delayMs: 10_000 },
        { text: "first main answer", usage: { cost: 0 } },
        { text: "second main answer", usage: { cost: 0 } },
      ])
      const ai = createAi({
        dialects: [
          {
            ...mock,
            async *stream(request, context) {
              const consultation = request.tools.length === 0 && mock.requests.length === 1
              if (consultation) opened.resolve()
              for await (const event of mock.stream(request, context)) {
                if (consultation && event.type === "error" && event.error.code === "aborted") {
                  terminalReady.resolve()
                  await release.promise
                }
                yield event
              }
            },
          },
        ],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
        retry: { retries: 0 },
      })
      const tree = new AgentTree({ ai, sections: () => [] })
      const store = SessionStore.create({ cwd: dir, dir })
      const tools = new ToolRegistry()
      tools.register(
        defineTool({
          name: "read",
          description: "read",
          parameters: {},
          execute: async () => textResult("ok"),
        }),
        "test",
      )
      const bus = new EventBus()
      const events: AnyEvent[] = []
      bus.subscribe((event) => {
        events.push(event)
        if (event.type === "budget.update" && event.data.costUsd === 4) charged.resolve()
      })
      const parent = new Agent({
        ai,
        model: ai.model("mock/commander"),
        cwd: dir,
        session: store,
        tools,
        tree,
        bus,
        sections: [],
      })
      parent.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "approval needed" }))
      store.appendDisplay({ type: "display", text: "origin", level: "info" })
      const group = tree.createGroup(parent, { name: "private work" })
      let resumed: Agent | undefined
      let worker: ReturnType<typeof startWorker> | undefined
      let workerDir: string | undefined
      try {
        const child = group.spawn({
          prompt: "private",
          model: "mock/worker",
          ephemeral: true,
          callableTools: ["read"],
          maxTurns: 1,
        })
        await bounded(opened.promise, "consultation opened")
        child.abort("abort while consultation is answering")
        await bounded(terminalReady.promise, "terminal")
        const result = await bounded(child.result(), "child result")
        expect(result.status).toBe("aborted")
        expect(result.usage.cost).toBe(1)
        await bounded(parent.dispose("switch"), "parent dispose")
        if (timing === "deleted origin") {
          rmSync(store.file)
        } else if (timing === "foreign lease") {
          workerDir = mkdtempSync(path.join(dir, "worker-"))
          worker = startWorker(workerDir, store.file, "hold")
          await waitFor(path.join(workerDir, "claimed"), worker)
        } else {
          resumed = new Agent({
            ai,
            model: parent.model,
            cwd: dir,
            session: SessionStore.open(store.file),
            tree,
            bus,
            sections: [],
          })
        }
        if (timing === "after turns") {
          await bounded(resumed!.prompt("first main question"))
          await bounded(resumed!.prompt("second main question"))
        }
        release.resolve()
        await bounded(charged.promise, "charged")
        if (timing === "before turns") {
          await bounded(resumed!.prompt("first main question"))
          await bounded(resumed!.prompt("second main question"))
        }
        await bus.flush()
        expect(tree.usage.cost).toBe(4)
        expect(group.info().usage.cost).toBe(4)
        expect(tree.subagent(child.id)).toBeUndefined()
        expect(events.filter((event) => event.type === "extension.error")).toEqual([])
        const warnings = events.flatMap((event) =>
          event.type === "extension.notice" &&
          event.data.level === "warning" &&
          event.data.source === "session"
            ? [event.data.text]
            : [],
        )
        if (timing === "deleted origin" || timing === "foreign lease") {
          expect(warnings).toHaveLength(1)
          expect(warnings[0]).toContain("usage")
          if (timing === "foreign lease") {
            expect(warnings[0]).toContain("another Amira process")
            expect(
              SessionStore.open(store.file)
                .entries.filter((entry) => entry.type === "side_usage")
                .map((entry) => entry.usage.cost),
            ).toEqual([1])
            writeFileSync(path.join(workerDir!, "release"), "go")
            await finishWorker(worker!, workerDir!)
            worker = undefined
            resumed = new Agent({
              ai,
              model: parent.model,
              cwd: dir,
              session: SessionStore.open(store.file),
              tree,
              bus,
              sections: [],
            })
            await bounded(resumed.prompt("the resumed writer is still healthy"))
            await bus.flush()
            expect(SessionStore.open(store.file).restore().messages).toEqual(resumed.messages)
            expect(resumed.messages).toHaveLength(2)
            expect(events.filter((event) => event.type === "extension.error")).toEqual([])
          }
        } else {
          expect(warnings).toEqual([])
          const disk = SessionStore.open(store.file)
          expect(disk.restore().messages).toEqual(resumed!.messages)
          expect(disk.restore().messages).toHaveLength(4)
          const costs = disk.entries
            .filter((entry) => entry.type === "side_usage")
            .map((entry) => entry.usage.cost ?? 0)
          expect(costs).toEqual([1, 3])
          expect(costs.reduce((sum, cost) => sum + cost, 0)).toBe(4)
          expect(mock.requests[3]!.messages).toHaveLength(3)
        }
      } finally {
        release.resolve()
        if (worker) {
          writeFileSync(path.join(workerDir!, "release"), "cleanup")
          await finishWorker(worker, workerDir!)
        }
        await bounded(resumed?.dispose() ?? Promise.resolve())
        await bounded(parent.dispose())
        rmSync(dir, { recursive: true, force: true })
      }
    },
    timing === "foreign lease" ? SPAWN_TEST_TIMEOUT_MS : 8000,
  )
}
