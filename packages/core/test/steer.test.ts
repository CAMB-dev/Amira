import { expect, test } from "bun:test"
import { createAi, createMockDialect, type Message, type MockStep } from "@amira/ai"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
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
  expect(events.filter((e) => e.type === "turn.start").length).toBe(2)
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
