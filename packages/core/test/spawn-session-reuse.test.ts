import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

function setup() {
  const mock = createMockDialect()
  for (let i = 0; i < 20; i++) mock.push(() => ({ text: "ok", usage: { input: 1, output: 1 } }))
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, sections: () => [{ name: "identity", text: "child" }] })
  const root = (sessionId: string) =>
    new Agent({
      ai,
      model: ai.model("mock/m"),
      cwd: process.cwd(),
      systemPrompt: "root",
      bus: new EventBus(),
      tree,
      tools: new ToolRegistry(),
      sessionId,
    })
  return { tree, root }
}

async function spawnsFrom(tree: AgentTree, agent: Agent) {
  const child = tree.createGroup(agent, { name: "probe" }).spawn({ prompt: "hi" })
  return (await child.result()).status
}

test("a replacement agent for the same session can spawn after the old one is disposed", async () => {
  // Rewind and same-session switches build the replacement before disposing the old agent.
  const { tree, root } = setup()
  const old = root("s_same")
  const next = root("s_same")
  await old.dispose("switch")
  expect(await spawnsFrom(tree, next)).toBe("done")
  await next.dispose()
})

test("resuming a session whose earlier agent was disposed can spawn again", async () => {
  const { tree, root } = setup()
  const first = root("s_back")
  await first.dispose("switch")
  const resumed = root("s_back")
  expect(await spawnsFrom(tree, resumed)).toBe("done")
  await resumed.dispose()
})

test("a disposed agent itself still cannot spawn", async () => {
  const { tree, root } = setup()
  const gone = root("s_gone")
  await gone.dispose()
  expect(() => tree.createGroup(gone, { name: "late" }).spawn({ prompt: "hi" })).toThrow()
})
