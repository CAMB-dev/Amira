import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { addUsage, createAi, createMockDialect, emptyUsage } from "@amira/ai"
import { knownUsageCost } from "@amira/ai/accounting"
import { defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { conversationUsage } from "../src/owned-conversations-usage.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

for (const partial of [false, true]) {
  test(`consultation iterator failure retains its ${partial ? "partially priced" : "priced"} receipt before releasing admission`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "amira-consult-throw-"))
    const mock = createMockDialect([
      { toolCalls: [{ name: "read", args: {} }], usage: { cost: 0 } },
      { text: "done", usage: { cost: 0 } },
    ])
    const ai = createAi({
      dialects: [
        {
          ...mock,
          async *stream(request, context) {
            if (request.model.id === "commander") {
              const priced = { ...emptyUsage(), input: 20, cost: 0.2 }
              const usage = partial ? addUsage(priced, { ...emptyUsage(), webSearchRequests: 1 }) : priced
              yield {
                type: "request.end",
                message: {
                  role: "assistant",
                  content: [],
                  model: { provider: "mock", model: "commander" },
                  usage,
                },
              }
              throw new Error("consultation adapter failure")
            }
            yield* mock.stream(request, context)
          },
        },
      ],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
      retry: { retries: 0 },
    })
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
    const tree = new AgentTree({ ai, sections: () => [] })
    const store = SessionStore.create({ cwd: home, dir: home })
    const parent = new Agent({
      ai,
      model: ai.model("mock/commander"),
      cwd: home,
      session: store,
      tools,
      tree,
      sections: [],
    })
    parent.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "review" }))
    const group = tree.createGroup(parent, { name: "private work" })
    try {
      const child = group.spawn({
        prompt: "private",
        title: "private worker",
        model: "mock/worker",
        callableTools: ["read"],
        ephemeral: true,
        maxTurns: 1,
      })
      await child.result()
      await tree.waitForChildren()
      expect(knownUsageCost(tree.usage)).toBeCloseTo(0.2)
      expect(group.info().usage.input).toBe(20)
      if (!partial) expect(group.info().usage.cost).toBeCloseTo(0.2)
      expect(conversationUsage(parent).own.knownCostUsd).toBe(0)
      expect(conversationUsage(parent).total).toMatchObject({ knownCostUsd: 0.2, complete: false })
      expect(conversationUsage(SessionStore.open(store.file)).total).toMatchObject({
        knownCostUsd: 0.2,
        complete: false,
      })
    } finally {
      await parent.dispose()
      tree.releaseScope()
      rmSync(home, { recursive: true, force: true })
    }
  })
}
