import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep, type ModelLimits } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { SessionStore } from "../src/session-store.ts"

const overflowAt = (limit: number): MockStep => ({
  error: {
    message: `HTTP 400: This model's maximum context length is ${limit} tokens. However, you requested ${limit + 5000} tokens.`,
    status: 400,
  },
})

async function setup(steps: MockStep[]) {
  const mock = createMockDialect(steps)
  const learned: { provider: string; modelId: string; limits: ModelLimits }[] = []
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "relay", dialect: "mock", baseUrl: "https://relay.example/v1" }],
    learnModelLimits: (provider, modelId, limits) =>
      void learned.push({ provider: provider.id, modelId, limits }),
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-overflow-window-"))
  const agent = new Agent({
    ai,
    model: ai.model("relay/m"),
    cwd: "/proj",
    systemPrompt: "sys",
    bus,
    session: SessionStore.create({ cwd: "/proj", dir }),
  })
  return { agent, ai, mock, bus, events, learned }
}

test("an overflow that states a smaller window is learned, then compacted to and retried", async () => {
  const { agent, ai, mock, bus, events, learned } = await setup([
    { text: "r1" },
    { text: "r2" },
    overflowAt(65_536),
    { text: "SUM" },
    { text: "r3" },
  ])
  expect(agent.model).toMatchObject({ contextWindow: 128_000, contextWindowSource: "default" })
  await agent.prompt("q1")
  await agent.prompt("q2")
  const r = await agent.prompt("q3")
  await bus.flush()
  expect(r.reason).toBe("done")
  expect(mock.requests).toHaveLength(5)
  expect(agent.model).toMatchObject({ id: "m", contextWindow: 65_536, contextWindowSource: "provider" })
  expect(events.find((e) => e.type === "compact.start")!.data).toMatchObject({ reason: "overflow" })
  expect(events.findLast((e) => e.type === "message.start")!.data).toMatchObject({ contextWindow: 65_536 })
  // The window is known now: no notice that it had to be guessed.
  expect(
    events.some(
      (e) => e.type === "extension.notice" && String((e.data as { text: string }).text).includes("not known"),
    ),
  ).toBe(false)
  expect(events.some((e) => e.type === "model.changed")).toBe(false)
  const notices = events.filter(
    (e) => e.type === "extension.notice" && (e.data as { source: string }).source === "context",
  )
  expect(notices.map((e) => (e.data as { text: string }).text)).toEqual([
    "The provider says relay/m fits 65,536 tokens; using that from now on. Set contextWindow in the provider's settings to override.",
  ])
  // Models resolved from now on use it, and the host was asked to keep it.
  expect(ai.model("relay/m")).toMatchObject({ contextWindow: 65_536, contextWindowSource: "provider" })
  expect(learned).toEqual([{ provider: "relay", modelId: "m", limits: { contextWindow: 65_536 } }])
})

test("an overflow never raises a window, and implausible limits are ignored", async () => {
  const { agent, ai, bus, learned } = await setup([
    { text: "r1" },
    overflowAt(200_000),
    { text: "SUM" },
    { text: "r2" },
    overflowAt(1000),
    { text: "r3" },
  ])
  await agent.prompt("q1")
  await agent.prompt("q2")
  await agent.prompt("q3")
  await bus.flush()
  expect(agent.model).toMatchObject({ contextWindow: 128_000, contextWindowSource: "default" })
  expect(ai.model("relay/m").contextWindow).toBe(128_000)
  expect(learned).toEqual([])
})

test("a limit from a request sent to a model the session left is not learned", async () => {
  const { agent, ai, mock, bus, events, learned } = await setup([{ text: "r1" }, { text: "r2" }])
  mock.push(
    () => {
      agent.setModel(ai.model("relay/n"))
      return overflowAt(65_536)
    },
    { text: "SUM" },
    { text: "r3" },
  )
  await agent.prompt("q1")
  await agent.prompt("q2")
  await agent.prompt("q3")
  await bus.flush()
  expect(agent.model).toMatchObject({ id: "n", contextWindow: 128_000, contextWindowSource: "default" })
  expect(ai.model("relay/n").contextWindow).toBe(128_000)
  expect(ai.model("relay/m").contextWindow).toBe(128_000)
  expect(learned).toEqual([])
  expect(
    events.some((e) => e.type === "extension.notice" && (e.data as { source: string }).source === "context"),
  ).toBe(false)
})
