import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  type Ai,
  type AssistantMessage,
  addUsage,
  createAi,
  createMockDialect,
  emptyUsage,
  type ModelRequest,
} from "@amira/ai"
import { addUsage as apiAddUsage, type ChildSession, defineTool, textResult } from "@amira/api"
import { costByModel, costReport } from "../../../extensions/commands/src/format.ts"
import { Agent } from "../src/agent.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree, SpawnError } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const promptOf = (request: ModelRequest) => {
  const content = request.messages.at(-1)?.content[0]
  return content?.type === "text" ? content.text : ""
}
async function flush() {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

for (const correction of ["unpriced", "priced", "duplicate"] as const) {
  test(`${correction} search snapshot settles once with known tree, group and persisted prices`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amira-consultation-pricing-"))
    const first = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<void>()
    const mock = createMockDialect(
      Array.from(
        { length: 10 },
        () => (request: ModelRequest) =>
          promptOf(request) === "private"
            ? { toolCalls: [{ name: "read", args: {} }], usage: { cost: 0 } }
            : { text: "done", usage: { cost: 0 } },
      ),
    )
    const base = createAi({
      dialects: [mock],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      retry: { retries: 0 },
    })
    const ai: Ai = {
      ...base,
      async *stream(request, signal) {
        if (request.tools.length) {
          yield* base.stream(request, signal)
          return
        }
        const message: AssistantMessage = {
          role: "assistant",
          model: { provider: "mock", model: "m" },
          content: [],
          usage: {
            ...emptyUsage(),
            input: 10,
            webSearchRequests: 1,
            ...(correction === "unpriced"
              ? {}
              : { webSearchCost: 0.1, cost: correction === "priced" ? 0.5 : 2 }),
          },
        }
        try {
          yield { type: "request.start" }
          yield { type: "request.end", message }
          first.resolve()
          await finish.promise
          message.usage = { ...emptyUsage(), input: 10, webSearchRequests: 1, webSearchCost: 0.1, cost: 2 }
          message.content = [{ type: "text", text: "APPROVE" }]
          yield { type: "done", message }
        } finally {
          closed.resolve()
        }
      },
    }
    const tree = new AgentTree({ ai, maxConcurrent: 2, sections: () => [] })
    const store = SessionStore.create({ cwd: dir, dir })
    store.append({ type: "display", text: "persist usage", level: "info" })
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
      name: "private work",
      budget: { costUsd: correction === "duplicate" ? 3 : 1 },
    })
    let child: ChildSession | undefined
    try {
      child = group.spawn({ prompt: "private", ephemeral: true, maxTurns: 1 })
      await first.promise
      expect(tree.usage.webSearchRequests).toBe(1)
      expect(tree.usage.cost).toBe(correction === "unpriced" ? undefined : correction === "priced" ? 0.5 : 2)
      finish.resolve()
      await closed.promise
      await flush()
      expect(tree.usage.cost).toBe(2)
      expect(group.info().usage.cost).toBe(2)
      expect(tree.usage.webSearchRequests).toBe(1)
      expect(tree.usage.input).toBe(10)
      if (correction !== "duplicate") {
        expect(() => group.spawn({ prompt: "sibling", ephemeral: true, maxTurns: 1 })).toThrow(SpawnError)
        expect(group.info().state).toBe("ended")
      } else expect(group.info().state).toBe("active")
      const saved = SessionStore.open(store.file).entries.filter((entry) => entry.type === "side_usage")
      for (const sum of [addUsage, apiAddUsage]) {
        const total = saved.reduce((total, entry) => sum(total, entry.usage), emptyUsage())
        expect(total.cost).toBe(2)
        expect(total.webSearchCost).toBe(0.1)
        expect(total.webSearchRequests).toBe(1)
        expect(total.input).toBe(10)
      }
      const replies: AssistantMessage[] = saved.map((entry) => ({
        role: "assistant",
        model: entry.model,
        content: [],
        usage: entry.usage,
      }))
      expect(costByModel(replies)[0]?.cost).toBe(2)
      expect(costReport([], [], saved)).not.toContain("price unknown")
      expect((await child.result()).status).toBe(correction === "duplicate" ? "done" : "aborted")
    } finally {
      finish.resolve()
      child?.abort("cleanup")
      await parent.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
