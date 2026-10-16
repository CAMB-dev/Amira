import { afterEach, expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { Agent, type AgentOptions } from "../src/agent.ts"
import { AgentTree } from "../src/subagents.ts"

const agents: Agent[] = []
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.dispose()
})

function setup(
  options: { maxSteps?: number; costUsd?: number; steps?: MockStep[]; endTurn?: () => boolean } = {},
) {
  const mock = createMockDialect(
    options.steps ??
      Array.from({ length: 550 }, (_, i) => ({
        toolCalls: [{ name: "echo", args: {}, id: `call-${i}` }],
        usage: { cost: 1 },
      })),
  )
  mock.push({ text: "finished" })
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({
    ai,
    sections: () => [],
    ...(options.costUsd !== undefined ? { budget: { costUsd: options.costUsd } } : {}),
  })
  const opts: AgentOptions = {
    ai,
    tree,
    model: ai.model("mock/test"),
    cwd: ".",
    compaction: { auto: false },
    endTurn: options.endTurn,
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
  }
  const agent = new Agent(opts)
  agents.push(agent)
  let toolCalls = 0
  agent.tools.register(
    defineTool({
      name: "echo",
      description: "",
      parameters: {},
      execute: async () => {
        toolCalls++
        return textResult("ok")
      },
    }),
    "test",
  )
  return { agent, mock, tree, opts, toolCalls: () => toolCalls }
}

test("the default model-call limit is 500", async () => {
  const { agent, mock, toolCalls } = setup()
  expect(await agent.prompt("go")).toEqual({
    reason: "error",
    steps: 500,
    error: "stopped after 500 model calls; raise agent.maxSteps or use --max-steps 0",
  })
  expect(mock.requests).toHaveLength(500)
  expect(toolCalls()).toBe(500)
})

test("a positive limit stops with guidance on raising it", async () => {
  const { agent, mock } = setup({ maxSteps: 3 })
  expect(await agent.prompt("go")).toEqual({
    reason: "error",
    steps: 3,
    error: "stopped after 3 model calls; raise agent.maxSteps or use --max-steps 0",
  })
  expect(mock.requests).toHaveLength(3)
})

for (const maxSteps of [500, 0]) {
  test(`a configured cost limit stops the main turn with maxSteps ${maxSteps}`, async () => {
    const { agent, mock, tree } = setup({ maxSteps, costUsd: 1.5 })
    expect(await agent.prompt("go")).toEqual({ reason: "aborted", steps: 2 })
    expect(mock.requests).toHaveLength(2)
    expect(tree.usage.cost).toBe(2)
    expect(agent.status).toBe("idle")
  })
}

for (const maxSteps of [0, 500]) {
  for (const queued of ["steering", "notice", "both"] as const) {
    test(`a budget-crossing text reply does not promote queued ${queued} with maxSteps ${maxSteps}`, async () => {
      const { agent, mock, tree } = setup({
        maxSteps,
        costUsd: 1,
        steps: [
          () => {
            if (queued !== "notice") agent.steer("continue")
            if (queued !== "steering") agent.steer("background result", { notice: true })
            return { text: "budget crossed", usage: { cost: 2 } }
          },
          { text: "must not run", usage: { cost: 2 } },
        ],
      })
      const events: AnyEvent[] = []
      agent.bus.subscribe((event) => void events.push(event))

      expect(await agent.prompt("go")).toEqual({ reason: "aborted", steps: 1 })
      await agent.bus.flush()
      expect(mock.requests).toHaveLength(1)
      expect(tree.usage.cost).toBe(2)
      expect(agent.messages).toHaveLength(2)
      expect(agent.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "budget crossed" }],
        usage: { cost: 2 },
      })
      expect(events.filter((event) => event.type === "turn.start")).toHaveLength(1)
      expect(events.filter((event) => event.type === "turn.end").map((event) => event.data)).toEqual([
        { reason: "aborted", steps: 1 },
      ])
      expect(events.some((event) => event.type === "turn.steer" && event.data.state === "promoted")).toBe(
        false,
      )
      expect(agent.waitingNotices).toBe(queued === "steering" ? 0 : 1)
      expect(agent.noticeRetry).toBeUndefined()
      expect(agent.status).toBe("idle")
    })
  }
}

test("an unlimited turn still stops on abort after passing 500 calls", async () => {
  const { agent, mock } = setup({ maxSteps: 0 })
  agent.tools.register(
    defineTool({
      name: "echo",
      description: "",
      parameters: {},
      override: true,
      execute: async () => {
        if (mock.requests.length === 505) agent.abort()
        return textResult("ok")
      },
    }),
    "test",
  )
  expect(await agent.prompt("go")).toEqual({ reason: "aborted", steps: 505 })
  expect(mock.requests).toHaveLength(505)
  expect(agent.status).toBe("idle")
})

test("an unlimited turn can abort during a model call", async () => {
  const { agent, mock } = setup({
    maxSteps: 0,
    steps: [
      () => {
        agent.abort()
        return { text: "interrupted reply" }
      },
    ],
  })
  expect(await agent.prompt("go")).toEqual({ reason: "aborted", steps: 1 })
  expect(mock.requests).toHaveLength(1)
})

test("an unlimited turn still honors an explicit endTurn stop", async () => {
  const { agent, mock, toolCalls } = setup({ maxSteps: 0, endTurn: () => true })
  expect(await agent.prompt("go")).toEqual({ reason: "done", steps: 1 })
  expect(mock.requests).toHaveLength(1)
  expect(toolCalls()).toBe(1)
})

test("an unlimited turn still stops on context overflow when compaction is disabled", async () => {
  const { agent, mock } = setup({
    maxSteps: 0,
    steps: [{ error: { message: "HTTP 400: maximum context length is 1000 tokens", status: 400 } }],
  })
  expect(await agent.prompt("go")).toMatchObject({ reason: "error", steps: 1, failure: { kind: "context" } })
  expect(mock.requests).toHaveLength(1)
})

test("sub-agents keep their 500-call limit under an unlimited parent", async () => {
  const { agent, mock, tree } = setup({ maxSteps: 0 })
  const child = tree.spawn(agent, { prompt: "go" })
  expect(await child.result()).toMatchObject({
    status: "error",
    steps: 500,
    error: "stopped after 500 model calls",
  })
  expect(mock.requests).toHaveLength(500)
  await tree.waitForChildren()
})

test("programmatic maxSteps rejects negative, fractional and non-finite values", () => {
  const { opts } = setup()
  for (const maxSteps of [-1, 1.5, NaN, Infinity]) {
    expect(() => new Agent({ ...opts, maxSteps })).toThrow("maxSteps must be a non-negative integer")
  }
})

test("zero allows 550 tool-calling model replies followed by completion", async () => {
  const { agent, mock, toolCalls } = setup({ maxSteps: 0 })
  expect(await agent.prompt("go")).toEqual({ reason: "done", steps: 551 })
  expect(mock.requests).toHaveLength(551)
  expect(toolCalls()).toBe(550)
})
