import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { requestBody as anthropicBody } from "../../ai/src/dialects/anthropic-request.ts"
import { geminiBody } from "../../ai/src/dialects/google-gemini.ts"
import { responsesBody } from "../../ai/src/dialects/openai-responses.ts"
import { Agent } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

for (const dialect of [
  { id: "openai-responses", model: "gpt-5", body: responsesBody },
  { id: "anthropic-messages", model: "claude-sonnet-4-5", body: anthropicBody },
  { id: "google-gemini", model: "gemini-3-pro", body: geminiBody },
]) {
  test(`${dialect.id}: owned kept-tool completion retains the normal callable definitions without permitting calls`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "amira-owned-complete-callable-"))
    const mock = createMockDialect([
      { text: "normal reply" },
      {
        text: "completion reply",
        toolCalls: ["read", "write", "web_search"].map((name) => ({ name, args: {} })),
      },
    ])
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
      fetch: (() => {
        throw new Error("Unexpected network request")
      }) as unknown as typeof fetch,
      retry: { retries: 0 },
    })
    const tools = new ToolRegistry()
    const executed: string[] = []
    tools.register(
      defineTool({
        name: "read",
        description: "Read a file",
        parameters: { type: "object" },
        execute: async () => {
          executed.push("read")
          return textResult("must not run")
        },
      }),
      "fixture",
    )
    const tree = new AgentTree({ ai, sections: () => [] })
    const main = new Agent({
      ai,
      model: ai.model(`test/${dialect.model}`),
      cwd: home,
      tools,
      tree,
      sections: [],
    })
    const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
    try {
      expect(main.model.caps.webSearch).toBe(true)
      const handle = await manager.forOwner("checks").openOrCreate(
        {
          key: "callable-completion",
          name: "Callable completion",
          cwd: home,
          systemPrompt: "Only read is callable.",
          callableTools: ["read"],
        },
        { askUser: async () => undefined },
      )
      await handle.send("Normal request")
      const history = handle.history()
      const result = await handle.complete({
        messages: [userMessage("Side request")],
        keepSessionTools: true,
      })
      expect(mock.requests).toHaveLength(2)
      expect(mock.requests[0]).toMatchObject({ model: { caps: { webSearch: false } } })
      expect(mock.requests[0]?.tools.map((tool) => tool.name)).toEqual(["read"])
      expect(JSON.stringify(bodies[0]?.tools)).not.toMatch(/web_search|googleSearch|"write"/)
      expect(result.toolsKept).toBe(true)
      expect(mock.requests[1]).toMatchObject({
        model: mock.requests[0]?.model,
        tools: mock.requests[0]?.tools,
        toolChoice: "none",
      })
      expect(bodies[1]?.tools).toEqual(bodies[0]?.tools)
      if (dialect.id === "google-gemini")
        expect(bodies[1]?.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } })
      else
        expect(bodies[1]?.tool_choice).toEqual(
          dialect.id === "anthropic-messages" ? { type: "none" } : "none",
        )
      expect(result.text).toBe("completion reply")
      expect(result.message.content.filter((block) => block.type === "toolCall")).toHaveLength(3)
      expect(executed).toEqual([])
      expect(handle.history()).toEqual(history)
      expect(main.model.caps.webSearch).toBe(true)
    } finally {
      await manager.drain()
      await main.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })
}
