import { expect, jest, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type Ai, createAi, createMockDialect, type ModelRequest } from "@amira/ai"
import { type ChildSession, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree, SpawnError } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

async function flush() {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}
const promptOf = (request: ModelRequest) => {
  const content = request.messages.at(-1)?.content[0]
  return content?.type === "text" ? content.text : ""
}

for (const scope of ["tree", "group"] as const) {
  test(`${scope}: a completed $2 consultation exhausts a $1 budget before its 60-second backoff`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amira-consult-backoff-budget-"))
    const backoff = Promise.withResolvers<void>()
    const reply = (request: ModelRequest) => {
      if (!request.tools.length)
        return { error: { message: "temporary failure", retryable: true }, usage: { cost: 2 } }
      if (promptOf(request) === "private")
        return { toolCalls: [{ name: "read", args: {} }], usage: { cost: 0 } }
      return { text: "sibling ran", usage: { cost: 0.5 } }
    }
    const mock = createMockDialect(Array.from({ length: 10 }, () => reply))
    const base = createAi({
      dialects: [mock],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      retry: { retries: 1, baseDelayMs: 60_000, maxDelayMs: 60_000 },
    })
    const ai: Ai = {
      ...base,
      async *stream(request, signal) {
        for await (const event of base.stream(request, signal)) {
          yield event
          if (event.type === "retry") backoff.resolve()
        }
      },
    }
    const tree = new AgentTree({
      ai,
      maxConcurrent: 2,
      sections: () => [],
      ...(scope === "tree" ? { budget: { costUsd: 1 } } : {}),
    })
    const store = SessionStore.create({ cwd: dir, dir })
    store.append({ type: "display", level: "info", text: "persist usage" })
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
    const parent = new Agent({
      ai,
      tree,
      tools,
      model: ai.model("mock/m"),
      cwd: dir,
      session: store,
      sections: [],
    })
    parent.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "approval required" }))
    const group = tree.createGroup(parent, {
      name: "work",
      ...(scope === "group" ? { budget: { costUsd: 1 } } : {}),
    })
    let child: ChildSession | undefined
    jest.useFakeTimers()
    const start = Date.now()
    try {
      child = group.spawn({ prompt: "private", ephemeral: true, callableTools: ["read"], maxTurns: 1 })
      await backoff.promise
      let sibling: ChildSession | undefined
      try {
        sibling = group.spawn({ prompt: "sibling", ephemeral: true, maxTurns: 1 })
      } catch (error) {
        expect(error).toBeInstanceOf(SpawnError)
        expect(String(error)).toMatch(/budget is spent|group .*has ended/)
      }
      await flush()
      const charges = store.entries
        .filter((entry) => entry.type === "side_usage")
        .map((entry) => entry.usage.cost ?? 0)
      expect({
        ledger: tree.usage.cost,
        group: group.info().usage.cost,
        booked: charges.reduce((sum, cost) => sum + cost, 0),
        blocked: !sibling,
      }).toEqual({ ledger: 2, group: 2, booked: 2, blocked: true })
      expect(mock.requests).toHaveLength(2)
      expect(Date.now()).toBe(start)
      jest.advanceTimersByTime(59_999)
      await flush()
      expect(tree.usage.cost).toBe(2)
      expect(
        store.entries.filter((entry) => entry.type === "side_usage").map((entry) => entry.usage.cost),
      ).toEqual([0, 2])
      expect((await child.result()).status).toBe("aborted")
      expect(
        SessionStore.open(store.file)
          .entries.filter((entry) => entry.type === "side_usage")
          .map((entry) => entry.usage.cost),
      ).toEqual([0, 2])
    } finally {
      child?.abort("test cleanup")
      jest.useRealTimers()
      await parent.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
