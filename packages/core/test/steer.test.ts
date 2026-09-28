import { expect, test } from "bun:test"
import { createAi, createMockDialect, type Message, type MockStep, userMessage } from "@amira/ai"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { Agent, AgentAbortedError } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"

function setup(steps: MockStep[]) {
  const mock = createMockDialect(steps)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const agent = new Agent({ ai, model: ai.model("mock/test"), cwd: process.cwd(), systemPrompt: "", bus })
  return { agent, mock, bus, events }
}

/** A tool that waits until released, so a test can steer while it runs. */
function gate() {
  let release!: () => void
  let started!: () => void
  const running = new Promise<void>((r) => {
    started = r
  })
  const released = new Promise<void>((r) => {
    release = r
  })
  const tool = defineTool({
    name: "wait",
    description: "",
    parameters: {},
    execute: async () => {
      started()
      await released
      return textResult("waited")
    },
  })
  return { tool, running, release }
}

const texts = (messages: Message[]) =>
  messages.map((m) =>
    m.role === "toolResult"
      ? "result"
      : `${m.role}:${m.content.map((b) => (b.type === "text" ? b.text : b.type)).join("|")}`,
  )

test("a steering message waits for the running tool and joins the history before the next call", async () => {
  const { agent, mock, bus, events } = setup([{ toolCalls: [{ name: "wait", args: {} }] }, { text: "ok" }])
  const g = gate()
  agent.tools.register(g.tool, "test")
  const done = agent.prompt("go")
  const turnId = agent.turnId
  await g.running
  agent.steer("also do B")
  expect(mock.requests.length).toBe(1)
  g.release()
  expect(await done).toEqual({ reason: "done", steps: 2 })
  await bus.flush()
  expect(texts(mock.requests[1]!.messages)).toEqual([
    "user:go",
    "assistant:toolCall",
    "result",
    "user:also do B",
  ])
  const steer = events.filter((e) => e.type === "turn.steer")
  expect(steer.map((e) => e.type === "turn.steer" && e.data.state)).toEqual(["queued", "injected"])
  expect(steer.every((e) => e.turnId === turnId)).toBe(true)
  const order = events.map((e) => e.type)
  expect(order.indexOf("tool.execute.end")).toBeLessThan(order.lastIndexOf("turn.steer"))
})

test("messages queued when the turn ends become the next prompt, as one turn", async () => {
  const { agent, bus, events } = setup([{ text: "first reply", delayMs: 5 }, { text: "second" }])
  const done = agent.prompt("go")
  await Bun.sleep(8)
  agent.steer("one")
  agent.steer("two")
  await done
  while (agent.turnId || agent.messages.length < 4) await Bun.sleep(5)
  await bus.flush()
  expect(texts(agent.messages)).toEqual([
    "user:go",
    "assistant:first reply",
    "user:one|two",
    "assistant:second",
  ])
  const starts = events.filter((e) => e.type === "turn.start")
  expect(starts.length).toBe(2)
  // Each queued message is marked promoted, pointing at the turn it starts.
  const steers = events.flatMap((e) => (e.type === "turn.steer" ? [e] : []))
  expect(steers.map((e) => e.data.state)).toEqual(["queued", "queued", "promoted", "promoted"])
  for (const e of steers.slice(2)) {
    expect(e.data.state === "promoted" && e.data.nextTurnId).toBe(starts[1]!.turnId!)
    expect(e.turnId).toBe(starts[0]!.turnId!)
    expect(e.seq).toBeLessThan(starts[1]!.seq)
  }
})

test("promoted messages keep their display: one as it is, several joined in order", async () => {
  const { agent } = setup([{ text: "first", delayMs: 5 }, { text: "second", delayMs: 5 }, { text: "third" }])
  const done = agent.prompt("go")
  await Bun.sleep(8)
  const skill = userMessage("skill text", { text: "/s", note: "Loaded skill s (1 line)" })
  agent.steer(skill)
  await done
  // The promoted turn has started, and is still waiting for its reply.
  expect(agent.turnId).toBeDefined()
  expect(agent.messages[2]).toBe(skill)
  agent.steer("plain")
  agent.steer(userMessage("more skill", { text: "/t", note: "Loaded skill t (2 lines)" }))
  while (agent.messages.length < 6 || agent.turnId) await Bun.sleep(5)
  expect(agent.messages[4]).toEqual({
    role: "user",
    content: [
      { type: "text", text: "plain" },
      { type: "text", text: "more skill" },
    ],
    display: { text: "plain\n/t", note: "Loaded skill t (2 lines)" },
  })
})

test("steering with no turn running starts one", async () => {
  const { agent } = setup([{ text: "hi" }])
  agent.steer("hello")
  expect(agent.turnId).toBeDefined()
  while (agent.turnId) await Bun.sleep(5)
  expect(texts(agent.messages)).toEqual(["user:hello", "assistant:hi"])
})

test("an abort drops queued steering messages and says so", async () => {
  const { agent, bus, events } = setup([{ toolCalls: [{ name: "wait", args: {} }] }, { text: "never" }])
  const g = gate()
  agent.tools.register(g.tool, "test")
  const done = agent.prompt("go")
  await g.running
  agent.steer("later")
  agent.abort()
  g.release()
  expect((await done).reason).toBe("aborted")
  await Bun.sleep(20)
  await bus.flush()
  const states = events.flatMap((e) => (e.type === "turn.steer" ? [e.data.state] : []))
  expect(states).toEqual(["queued", "dropped"])
  expect(agent.turnId).toBeUndefined()
  expect(texts(agent.messages)).not.toContain("user:later")
})

test("prompt takes a caller-chosen turn id and exposes it synchronously", async () => {
  const { agent, bus, events } = setup([{ text: "hi" }])
  const done = agent.prompt("go", { turnId: "t_mine" })
  expect(agent.turnId).toBe("t_mine")
  await done
  await bus.flush()
  expect(agent.turnId).toBeUndefined()
  expect(events.filter((e) => e.type === "turn.start")[0]!.turnId).toBe("t_mine")
})

test("messages sent during a manual compaction start one turn when it ends", async () => {
  const { agent, mock, bus, events } = setup([
    { text: "r1" },
    { text: "r2" },
    { text: "SUMMARY", delayMs: 50 },
    { text: "after" },
  ])
  await agent.prompt("q1")
  await agent.prompt("q2")
  const compacted = agent.compact()
  expect(agent.busy).toBe(true)
  const result = agent.prompt("sent while compacting", { turnId: "t_later" })
  agent.steer("and this too")
  // A second prompt is refused, as it is while a turn runs.
  await expect(agent.prompt("third")).rejects.toThrow("already running")
  expect(agent.turnId).toBeUndefined()
  expect(await compacted).toBe(true)
  // The turn is running by the time compact() resolves.
  expect(agent.turnId).toBe("t_later")
  expect(await result).toEqual({ reason: "done", steps: 1 })
  await bus.flush()
  expect(mock.requests).toHaveLength(4)
  const last = mock.requests[3]!.messages.at(-1)!
  expect(texts([last])).toEqual(["user:sent while compacting|and this too"])
  const steers = events.filter((e) => e.type === "turn.steer")
  expect(steers.map((e) => [e.data.state, e.turnId])).toEqual([
    ["queued", undefined],
    ["promoted", undefined],
  ])
  expect(steers[1]!.data).toMatchObject({ nextTurnId: "t_later" })
})

test("aborting a manual compaction drops what was sent meanwhile, like aborting a turn", async () => {
  const { agent, mock, bus, events } = setup([{ text: "r1" }, { text: "r2" }, { text: "S", delayMs: 200 }])
  await agent.prompt("q1")
  await agent.prompt("q2")
  const compacted = agent.compact()
  const held = agent.prompt("held")
  agent.steer("steered")
  agent.abort()
  expect(await compacted).toBe(false)
  await expect(held).rejects.toBeInstanceOf(AgentAbortedError)
  await bus.flush()
  expect(agent.busy).toBe(false)
  expect(JSON.stringify(mock.requests)).not.toContain("held")
  expect(events.filter((e) => e.type === "turn.start")).toHaveLength(2)
  const steers = events
    .filter((e) => e.type === "turn.steer")
    .map((e) => [e.data.state, texts([e.data.message])[0]])
  expect(steers).toEqual([
    ["queued", "user:steered"],
    ["dropped", "user:held"],
    ["dropped", "user:steered"],
  ])
})

test("a steer during a manual compaction is not lost when the compaction fails", async () => {
  const { agent, mock } = setup([
    { text: "r1" },
    { text: "r2" },
    { error: { message: "no" } },
    { text: "after" },
  ])
  await agent.prompt("q1")
  await agent.prompt("q2")
  const compacted = agent.compact()
  agent.steer("keep me")
  expect(await compacted).toBe(false)
  while (agent.busy) await Bun.sleep(5)
  expect(texts([mock.requests.at(-1)!.messages.at(-1)!])).toEqual(["user:keep me"])
})
