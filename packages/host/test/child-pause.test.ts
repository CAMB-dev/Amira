import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { Agent, EventBus, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { AgentTree } from "../src/subagents.ts"

test("ChildSession exposes paused, pause(), and resume() for active working children", async () => {
  let releaseTool!: () => void
  const toolStarted = new Promise<void>((resolve) => {
    // resolved inside tool execute
    releaseTool = resolve
  })
  let unblockTool!: () => void
  const toolHold = new Promise<void>((resolve) => {
    unblockTool = resolve
  })

  const bus = new EventBus()
  const tools = new ToolRegistry()
  tools.register(
    defineTool({
      name: "hold",
      description: "holds briefly",
      parameters: {},
      execute: async () => {
        releaseTool()
        await toolHold
        return textResult("done")
      },
    }),
    "test",
  )

  const ai = createAi({
    dialects: [
      createMockDialect([
        { toolCalls: [{ id: "c1", name: "hold", args: {} }] },
        { text: "resumed and finished" },
      ]),
    ],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const root = new Agent({
    ai,
    model: ai.model("mock/m1"),
    cwd: process.cwd(),
    bus,
    tools,
    interceptors: new InterceptorRegistry(),
    tree,
  })

  const states: string[] = []
  bus.subscribe(
    (e) => {
      if (e.type === "subagent.state") states.push(e.data.state)
    },
    { types: ["subagent.state"] },
  )

  const child = tree.spawn(root, { prompt: "run hold" })
  await toolStarted
  expect(child.state).toBe("working")
  expect(child.paused).toBe(false)
  expect(child.pause()).toBe(true)
  expect(child.paused).toBe(true)
  expect(child.pause()).toBe(false) // already paused

  // Unblock the tool; the child should stay paused before calling the model for step 2.
  unblockTool()
  await Bun.sleep(20)
  expect(child.paused).toBe(true)
  expect(states).toContain("paused")

  expect(child.resume()).toBe(true)
  expect(child.paused).toBe(false)
  const result = await child.result()
  expect(result.status).toBe("done")
  expect(result.text).toBe("resumed and finished")
  expect(child.paused).toBe(false)
  expect(child.pause()).toBe(false) // ended
})
