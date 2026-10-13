import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { responsesBody } from "../../ai/src/dialects/openai-responses.ts"
import { Agent } from "../src/agent.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

test("a child's approval consultation also omits hosted tools excluded by its callable list", async () => {
  const mock = createMockDialect([
    { toolCalls: [{ name: "read", args: {} }] },
    { text: "APPROVE" },
    { text: "done" },
  ])
  const bodies: Record<string, unknown>[] = []
  const ai = createAi({
    dialects: [
      {
        ...mock,
        id: "openai-responses",
        async *stream(request, context) {
          bodies.push(responsesBody(request))
          yield* mock.stream(request, context)
        },
      },
    ],
    providers: [
      {
        id: "test",
        dialect: "openai-responses",
        baseUrl: "https://provider.invalid",
        compat: { webSearch: true },
      },
    ],
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const tools = new ToolRegistry()
  tools.register(
    defineTool({
      name: "read",
      description: "read",
      parameters: { type: "object" },
      execute: async () => textResult("ok"),
    }),
    "test",
  )
  const parent = new Agent({
    ai,
    model: ai.model("test/gpt-5"),
    cwd: process.cwd(),
    tools,
    tree,
    sections: [],
  })
  parent.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "approval required" }))
  try {
    const child = tree.spawn(parent, {
      prompt: "private",
      ephemeral: true,
      callableTools: ["read"],
      maxTurns: 1,
    })
    expect((await child.result()).status).toBe("done")
    expect(mock.requests).toHaveLength(3)
    expect(mock.requests[1]!.tools).toEqual([])
    expect(bodies[1]!.tools).toBeUndefined()
    expect(parent.model.caps.webSearch).toBe(true)
  } finally {
    await parent.dispose()
  }
})
