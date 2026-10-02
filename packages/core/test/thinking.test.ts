import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { Agent, type AgentOptions } from "../src/agent.ts"
import { validateSettings } from "../src/config/schema.ts"
import { AgentTree } from "../src/subagents.ts"

const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-thinking-core-"))
const levels = ["low", "medium", "high", "xhigh", "max"] as const

function setup(extra: Partial<AgentOptions> = {}, steps: MockStep[] = [{ text: "done" }]) {
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [
      {
        id: "mock",
        dialect: "mock",
        baseUrl: "",
        models: [
          { id: "think", caps: { thinking: true } },
          { id: "other", caps: { thinking: true } },
          { id: "plain", caps: { thinking: false } },
        ],
      },
    ],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const agent = new Agent({ ai, model: ai.model("mock/think"), cwd, tree, ...extra })
  return { agent, ai, tree, mock }
}

test.each([...levels])("validates top-level and per-model thinking %s", (thinking) => {
  const input = { thinking, providers: { mock: { models: [{ id: "think", thinking }] } } }
  expect(validateSettings(input, "settings.json")).toEqual({ settings: input, warnings: [] })
})

test.each(["invalid", "", null, 3, { effort: "high" }])(
  "rejects invalid thinking %j at either scope",
  (thinking) => {
    for (const input of [{ thinking }, { providers: { mock: { models: [{ id: "think", thinking }] } } }]) {
      expect(() => validateSettings(input, "settings.json")).toThrow(
        'one of "low", "medium", "high", "xhigh", "max"',
      )
    }
  },
)

test.each([...levels])("main conversation requests send configured thinking %s", async (thinking) => {
  const { agent, mock } = setup({ defaultThinking: thinking })
  expect((await agent.prompt("hello")).reason).toBe("done")
  expect(mock.requests[0]?.reasoning).toEqual({ effort: thinking })
})

test("unset effort is absent from the main request", async () => {
  const { agent, mock } = setup()
  await agent.prompt("hello")
  expect(mock.requests).toHaveLength(1)
  expect(mock.requests[0]).not.toHaveProperty("reasoning")
})

test.each([...levels])("non-thinking models never receive configured effort %s", async (thinking) => {
  const { agent, ai, mock } = setup({ thinking })
  agent.setModel(ai.model("mock/plain"))
  await agent.prompt("hello")
  expect(mock.requests).toHaveLength(1)
  expect(mock.requests[0]).not.toHaveProperty("reasoning")
})

test("per-model effort follows model switches and falls back to the top-level setting", async () => {
  const { agent, ai, mock } = setup(
    {
      defaultThinking: "low",
      providerSettings: { mock: { models: [{ id: "think", thinking: "xhigh" }] } },
    },
    [{ text: "one" }, { text: "two" }, { text: "three" }],
  )
  await agent.prompt("one")
  agent.setModel(ai.model("mock/other"))
  await agent.prompt("two")
  agent.setModel(ai.model("mock/think"))
  await agent.prompt("three")
  expect(mock.requests.map((r) => r.reasoning?.effort)).toEqual(["xhigh", "low", "xhigh"])
})

test.each(["fresh", "fork"] as const)(
  "%s children inherit the parent's resolved effort even on another model",
  async (context) => {
    const { agent, tree, mock } = setup({
      defaultThinking: "low",
      providerSettings: {
        mock: {
          models: [
            { id: "think", thinking: "xhigh" },
            { id: "other", thinking: "medium" },
          ],
        },
      },
    })
    const child = tree.spawn(agent, { prompt: "work", model: "mock/other", context })
    expect((await child.result()).status).toBe("done")
    expect(mock.requests[0]?.reasoning).toEqual({ effort: "xhigh" })
  },
)

test("a non-thinking child omits the inherited effort", async () => {
  const { agent, tree, mock } = setup({ thinking: "max" })
  expect((await tree.spawn(agent, { prompt: "work", model: "mock/plain" }).result()).status).toBe("done")
  expect(mock.requests[0]).not.toHaveProperty("reasoning")
})

test("an unset parent leaves its child effort unset even when the child's model has a setting", async () => {
  const { agent, tree, mock } = setup({
    providerSettings: { mock: { models: [{ id: "other", thinking: "high" }] } },
  })
  expect((await tree.spawn(agent, { prompt: "work", model: "mock/other" }).result()).status).toBe("done")
  expect(mock.requests[0]).not.toHaveProperty("reasoning")
})

test("a thinking child inherits the configured effort from a non-thinking parent", async () => {
  const { agent, ai, tree, mock } = setup({ thinking: "max" })
  agent.setModel(ai.model("mock/plain"))
  expect((await tree.spawn(agent, { prompt: "work", model: "mock/think" }).result()).status).toBe("done")
  expect(mock.requests[0]?.reasoning).toEqual({ effort: "max" })
})

test.each(["fresh", "fork"] as const)(
  "%s children spawned after an override inherit the new effort, including default",
  async (context) => {
    const { agent, ai, tree, mock } = setup(
      {
        thinking: "high",
        defaultThinking: "low",
        providerSettings: { mock: { models: [{ id: "other", thinking: "medium" }] } },
      },
      Array.from({ length: 4 }, () => ({ text: "done" })),
    )
    const spawn = async () => {
      const child = tree.spawn(agent, { prompt: "work", model: "mock/other", context })
      expect((await child.result()).status).toBe("done")
    }
    await spawn()
    agent.setThinking("xhigh")
    await spawn()
    agent.setModel(ai.model("mock/plain"))
    agent.setThinking("max")
    await spawn()
    agent.setThinking(undefined)
    await spawn()
    expect(mock.requests.map((r) => r.reasoning?.effort)).toEqual(["high", "xhigh", "max", undefined])
    expect(mock.requests[3]).not.toHaveProperty("reasoning")
  },
)

test("compaction does not inherit the main conversation's effort", async () => {
  const { agent, mock } = setup({ thinking: "max", compaction: { auto: false, keepTurns: 1 } }, [
    { text: "first" },
    { text: "second" },
    { text: "summary" },
    { text: "after" },
  ])
  await agent.prompt("first")
  await agent.prompt("second")
  expect(await agent.compact("Summarize")).toBe(true)
  await agent.prompt("continue")
  expect(mock.requests).toHaveLength(4)
  expect(mock.requests.map((r) => r.reasoning?.effort)).toEqual(["max", "max", undefined, "max"])
  expect(mock.requests[2]).not.toHaveProperty("reasoning")
})
