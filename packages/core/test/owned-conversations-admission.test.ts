import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { type ChildSession, defineTool, type SpawnGroup, type ToolSession, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { Child } from "../src/subagents/child.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

function fixture(source: "send" | "runTool" = "runTool") {
  const home = mkdtempSync(path.join(tmpdir(), "amira-owned-admission-"))
  const steps: MockStep[] = Array.from({ length: 8 }, () => ({ text: "ready" }))
  if (source === "send") steps.unshift({ toolCalls: [{ name: "hold", args: {} }] })
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, sections: () => [] })
  const main = new Agent({ ai, model: ai.model("mock/test"), cwd: home, tools, tree, sections: [] })
  const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
  const entered = Promise.withResolvers<ToolSession>()
  const sessions: ToolSession[] = []
  const finish = Promise.withResolvers<void>()
  tools.register(
    defineTool({
      name: "hold",
      description: "Hold an owned operation while cancellation drains",
      parameters: { type: "object" },
      traits: { readOnly: true },
      execute: async (_args, context) => {
        sessions.push(context.session!)
        entered.resolve(context.session!)
        // Deliberately ignore cancellation so teardown stays at its deterministic drain barrier.
        await finish.promise
        return textResult("finished")
      },
    }),
    "test",
  )
  return {
    mock,
    entered,
    finish,
    sessions,
    open: () =>
      manager.forOwner("checks").openOrCreate(
        {
          key: "checks",
          name: "Checks",
          cwd: home,
          systemPrompt: "Run mock checks.",
          callableTools: ["hold"],
        },
        { askUser: async () => undefined },
      ),
    cleanup: async () => {
      finish.resolve()
      await manager.drain()
      await main.dispose()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

for (const source of ["send", "runTool"] as const) {
  for (const action of ["stop", "release", "abort"] as const) {
    for (const capability of ["handle group", "tool spawn", "tool group"] as const) {
      test(`${action} revokes ${capability} admission before waiting for owned ${source}`, async () => {
        const f = fixture(source)
        const handle = await f.open()
        const controller = new AbortController()
        const running =
          source === "send"
            ? handle.send("hold", { signal: controller.signal })
            : handle.runTool("hold", {}, { signal: controller.signal })
        const session = await f.entered.promise
        const children: ChildSession[] = []
        const groups: SpawnGroup[] = []
        let draining: Promise<void> | undefined
        try {
          if (action === "abort") controller.abort()
          else draining = handle[action]()
          const admit = () => {
            if (capability === "tool spawn") {
              children.push(session.spawn!({ prompt: "late persistent child", persistent: true }))
            } else {
              const group =
                capability === "handle group"
                  ? handle.createGroup({ name: "late group" })
                  : session.createGroup!({ name: "late group" })
              groups.push(group)
              children.push(group.spawn({ prompt: "late persistent child", persistent: true }))
            }
          }
          expect(admit).toThrow(/stopp|releas|abort|ended|cancel/i)
          expect(f.mock.requests).toHaveLength(source === "send" ? 1 : 0)
        } finally {
          // On the buggy implementation late persistent children miss abortAll's snapshot.
          // Abort them explicitly before awaiting teardown, including when the assertion fails.
          for (const child of children) child.abort("regression cleanup")
          for (const group of groups) group.end("regression cleanup")
          f.finish.resolve()
          await running
          await draining
          await f.cleanup()
        }
      })
    }
  }

  for (const action of ["stop", "release", "abort"] as const) {
    test(`${action} keeps captured ${source} tool capabilities revoked after draining`, async () => {
      const f = fixture(source)
      const handle = await f.open()
      const controller = new AbortController()
      const running =
        source === "send"
          ? handle.send("hold", { signal: controller.signal })
          : handle.runTool("hold", {}, { signal: controller.signal })
      const session = await f.entered.promise
      const capturedGroup = session.createGroup!({ name: "captured group" })
      const children: ChildSession[] = []
      const groups: SpawnGroup[] = []
      try {
        let draining: Promise<void> | undefined
        if (action === "abort") controller.abort()
        else draining = handle[action]()
        f.finish.resolve()
        await running
        await draining
        if (action !== "release") {
          // Stopping is not permanent disposal: new work on the same handle remains valid.
          await handle.send("fresh turn")
          const child = handle.createGroup({ name: "fresh group" }).spawn({ prompt: "fresh child" })
          children.push(child)
          expect((await child.result()).status).toBe("done")
          await handle.runTool("hold", {})
          const freshSession = f.sessions.at(-1)!
          const freshChild = freshSession.spawn!({ prompt: "fresh tool child" })
          children.push(freshChild)
          expect((await freshChild.result()).status).toBe("done")
          const freshGroupChild = freshSession.createGroup!({ name: "fresh tool group" }).spawn({
            prompt: "fresh group child",
          })
          children.push(freshGroupChild)
          expect((await freshGroupChild.result()).status).toBe("done")
        }
        expect(() => {
          children.push(session.spawn!({ prompt: "stale persistent child", persistent: true }))
        }).toThrow(/stopp|releas|abort|ended|cancel/i)
        expect(() => {
          groups.push(session.createGroup!({ name: "stale group" }))
        }).toThrow(/stopp|releas|abort|ended|cancel/i)
        expect(() => {
          children.push(capturedGroup.spawn({ prompt: "stale group child", persistent: true }))
        }).toThrow(/stopp|releas|abort|ended|cancel/i)
      } finally {
        for (const child of children) child.abort("regression cleanup")
        for (const group of groups) group.end("regression cleanup")
        capturedGroup.end("regression cleanup")
        await f.cleanup()
      }
    })
  }
}

for (const ephemeral of [false, true]) {
  for (const action of ["abort", "stop"] as const) {
    test(`${action} revokes a draining ${ephemeral ? "private" : "ordinary"} child's spawn admission`, async () => {
      const f = fixture("send")
      const handle = await f.open()
      const parent = handle
        .createGroup({ name: "parent" })
        .spawn({ prompt: "hold", persistent: true, ephemeral })
      const session = await f.entered.promise
      const children: ChildSession[] = []
      const groups: SpawnGroup[] = []
      if (!(parent instanceof Child)) throw new Error("expected tree child")
      const tree = parent.agent.tree!
      const group = tree.createGroup(parent.agent, { name: "unbound group" })
      try {
        parent[action]("parent cancelled")
        expect(() => {
          children.push(session.spawn!({ prompt: "late child", persistent: true }))
        }).toThrow(/stopp|releas|abort|ended|cancel/i)
        expect(() => {
          groups.push(session.createGroup!({ name: "late group" }))
        }).toThrow(/stopp|releas|abort|ended|cancel/i)
        expect(() => {
          children.push(group.spawn({ prompt: "late group child", persistent: true }))
        }).toThrow(/stopp|releas|abort|ended|cancel/i)
        f.finish.resolve()
        await parent.result()
        expect(() => {
          children.push(tree.spawn(parent.agent, { prompt: "ended parent child", persistent: true }))
        }).toThrow(/stopp|releas|abort|ended|cancel/i)
        expect(() => {
          groups.push(tree.createGroup(parent.agent, { name: "ended parent group" }))
        }).toThrow(/stopp|releas|abort|ended|cancel/i)
      } finally {
        for (const child of children) child.abort("regression cleanup")
        for (const extra of groups) extra.end("regression cleanup")
        parent.abort("regression cleanup")
        group.end("regression cleanup")
        f.finish.resolve()
        await parent.result()
        await f.cleanup()
      }
    })
  }
}
