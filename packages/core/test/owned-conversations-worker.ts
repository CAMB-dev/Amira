import { createAi, createMockDialect } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const [home, id] = process.argv.slice(2)
if (!home || !id) throw new Error("worker requires an isolated home and conversation id")
const mock = createMockDialect([])
const ai = createAi({
  dialects: [mock],
  providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
  retry: { retries: 0 },
})
const tools = new ToolRegistry()
const tree = new AgentTree({ ai, sections: () => [] })
const main = new Agent({ ai, model: ai.model("mock/test"), cwd: home, tools, tree, sections: [] })
const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
try {
  const handle = await manager.forOwner("notes").open(id, { askUser: async () => undefined })
  console.log(
    JSON.stringify({
      id: handle.id,
      roles: handle.history().map((message) => message.role),
      requests: mock.requests.length,
    }),
  )
} catch (error) {
  console.log(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      requests: mock.requests.length,
    }),
  )
} finally {
  await manager.drain()
  await main.dispose()
}
