import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const [home, phase] = process.argv.slice(2)
if (!home || !phase) throw new Error("isolated home and crash phase required")
const keepAlive = setInterval(() => {}, 1000)
const mock = createMockDialect(
  phase === "question"
    ? [{ toolCalls: [{ name: "ask_user", id: "pending", args: {} }] }]
    : [{ text: "unfinished reply" }],
)
const ai = createAi({
  dialects: [
    {
      ...mock,
      async *stream(request, context) {
        if (phase === "request") {
          writeFileSync(path.join(home, "ready.json"), readFileSync(path.join(home, "identity.json")))
          await new Promise(() => {})
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
    name: "ask_user",
    description: "Ask",
    parameters: { type: "object" },
    execute: async (_args, context) => {
      await context.session!.askUser!([{ question: "Choose?", options: [{ label: "A" }] }], context.signal)
      return textResult("answered")
    },
  }),
  "fixture",
)
const tree = new AgentTree({ ai, sections: () => [] })
const main = new Agent({ ai, model: ai.model("mock/test"), cwd: home, tools, tree, sections: [] })
const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
try {
  const conversation = await manager.forOwner("notes").openOrCreate(
    { key: "design", name: "Design", cwd: home, systemPrompt: "Research", callableTools: ["ask_user"] },
    {
      askUser: async (_questions, { sessionId }) => {
        writeFileSync(path.join(home, "ready.json"), JSON.stringify({ id: sessionId }))
        return new Promise(() => {})
      },
    },
  )
  // Model streams do not carry the session id; record the stable identity before sending.
  writeFileSync(path.join(home, "identity.json"), JSON.stringify({ id: conversation.id }))
  await conversation.send("Start an unfinished turn")
} finally {
  clearInterval(keepAlive)
  await manager.drain()
  await main.dispose()
}
