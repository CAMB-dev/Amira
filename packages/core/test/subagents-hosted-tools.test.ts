import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { requestBody as anthropicBody } from "../../ai/src/dialects/anthropic-request.ts"
import { geminiBody } from "../../ai/src/dialects/google-gemini.ts"
import { responsesBody } from "../../ai/src/dialects/openai-responses.ts"
import { Agent } from "../src/agent.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const dialects = [
  { id: "openai-responses", model: "gpt-5", body: responsesBody },
  { id: "anthropic-messages", model: "claude-sonnet-4-5", body: anthropicBody },
  { id: "google-gemini", model: "gemini-3-pro", body: geminiBody },
]

for (const dialect of dialects) {
  test(`${dialect.id}: callableTools omits excluded hosted search without changing local declarations`, async () => {
    const mock = createMockDialect(Array.from({ length: 4 }, () => ({ text: "done" })))
    const bodies: Record<string, unknown>[] = []
    const ai = createAi({
      dialects: [
        {
          ...mock,
          id: dialect.id,
          async *stream(request, context) {
            bodies.push(dialect.body(request))
            yield* mock.stream(request, context)
          },
        },
      ],
      providers: [
        {
          id: "test",
          dialect: dialect.id,
          baseUrl: "https://provider.invalid",
          compat: { webSearch: true },
        },
      ],
    })
    const tree = new AgentTree({ ai, sections: () => [] })
    const tools = new ToolRegistry()
    for (const name of ["read", "write", "deferred"]) {
      tools.register(
        defineTool({
          name,
          description: name,
          parameters: { type: "object" },
          ...(name === "deferred" ? { exposure: "deferred" as const } : {}),
          execute: async () => textResult("ok"),
        }),
        "test",
      )
    }
    const parent = new Agent({
      ai,
      model: ai.model(`test/${dialect.model}`),
      cwd: process.cwd(),
      tools,
      tree,
      sections: [],
    })
    parent.loadTools(["deferred"])
    try {
      await parent.prompt("main history")
      const requests: (string[] | undefined)[] = [[], ["read"], ["web_search"]]
      for (const callableTools of requests) {
        const child = tree.spawn(parent, {
          prompt: "side question",
          context: "fork",
          ephemeral: true,
          callableTools,
          maxTurns: 1,
        })
        expect((await child.result()).status).toBe("done")
      }
      const parentRequest = mock.requests[0]!
      expect(parentRequest.tools.map((tool) => tool.name)).toEqual(["read", "write", "deferred"])
      for (const request of mock.requests.slice(1)) {
        expect(request.tools).toEqual(parentRequest.tools)
        expect(request.systemPrompt).toBe(parentRequest.systemPrompt)
      }
      const localDeclarations = (body: Record<string, unknown>) => {
        if (dialect.id === "google-gemini") {
          return (body.tools as { functionDeclarations?: unknown[] }[]).flatMap(
            (tool) => tool.functionDeclarations ?? [],
          )
        }
        return (body.tools as { name?: string; type?: string }[]).filter(
          (tool) => tool.name !== "web_search" && tool.type !== "web_search",
        )
      }
      expect(localDeclarations(bodies[1]!)).toEqual(localDeclarations(bodies[0]!))
      expect(localDeclarations(bodies[2]!)).toEqual(localDeclarations(bodies[0]!))
      expect(bodies[3]!.tools).toEqual(bodies[0]!.tools)
      for (const body of bodies.slice(1, 3)) {
        expect(JSON.stringify(body.tools)).not.toContain("web_search")
        expect(JSON.stringify(body.tools)).not.toContain("googleSearch")
      }
      expect(mock.requests[0]!.model.caps.webSearch).toBe(true)
      expect(parent.model.caps.webSearch).toBe(true)
    } finally {
      await parent.dispose()
    }
  })
}
