import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { requestBody as anthropicBody } from "../../ai/src/dialects/anthropic-request.ts"
import { geminiBody } from "../../ai/src/dialects/google-gemini.ts"
import { responsesBody } from "../../ai/src/dialects/openai-responses.ts"
import { Agent } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const dialects = [
  { id: "openai-responses", model: "gpt-5", body: responsesBody },
  { id: "anthropic-messages", model: "claude-sonnet-4-5", body: anthropicBody },
  { id: "google-gemini", model: "gemini-3-pro", body: geminiBody },
]

for (const dialect of dialects) {
  for (const allowed of [false, true]) {
    test(`${dialect.id}: owned hosted-search policy survives reopen and bounds children (${allowed})`, async () => {
      const home = mkdtempSync(path.join(tmpdir(), "amira-owned-hosted-"))
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
        retry: { retries: 0 },
      })
      const tools = new ToolRegistry()
      for (const name of ["read", "write"]) {
        tools.register(
          defineTool({
            name,
            description: name,
            parameters: { type: "object" },
            execute: async () => textResult("ok"),
          }),
          "fixture",
        )
      }
      const tree = new AgentTree({ ai, sections: () => [] })
      const main = new Agent({
        ai,
        model: ai.model(`test/${dialect.model}`),
        cwd: home,
        tools,
        tree,
        sections: [],
      })
      const createManager = () => new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
      const first = createManager()
      const second = createManager()
      const runtime = { askUser: async () => undefined }
      try {
        await main.prompt("main can search")
        const conversation = await first.forOwner("notes").openOrCreate(
          {
            key: "design",
            name: "Design",
            cwd: home,
            systemPrompt: "Research.",
            callableTools: allowed ? ["read", "web_search"] : ["read"],
          },
          runtime,
        )
        await conversation.send("research")
        await conversation.release()
        const reopened = await second.forOwner("notes").open(conversation.id, runtime)
        expect(bodies).toHaveLength(2)
        await reopened.send("continue")
        const group = reopened.createGroup({ name: "Research" })
        const child = group.spawn({
          prompt: "bounded research",
          callableTools: allowed ? [] : ["read", "web_search"],
        })
        expect((await child.result()).status).toBe("done")
        group.end()
        expect(bodies).toHaveLength(4)
        const hosted = (body: Record<string, unknown>) =>
          /web_search|googleSearch/.test(JSON.stringify(body.tools))
        expect(hosted(bodies[0]!)).toBe(true)
        expect(hosted(bodies[1]!)).toBe(allowed)
        expect(hosted(bodies[2]!)).toBe(allowed)
        expect(hosted(bodies[3]!)).toBe(false)
        // Excluding hosted search must not also erase the local read declaration.
        for (const body of bodies) expect(JSON.stringify(body.tools)).toContain('"read"')
        expect(main.model.caps.webSearch).toBe(true)
      } finally {
        await first.drain()
        await second.drain()
        await main.dispose()
        rmSync(home, { recursive: true, force: true })
      }
    })
  }
}
