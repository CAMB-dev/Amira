import { expect, test } from "bun:test"
import { createAi, createMockDialect, type Message, type MockStep, userMessage } from "@amira/ai"
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

/** A tool that waits until released. */
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

const notice = (text: string) => userMessage(text, { text: `◆ ${text}`, origin: "subagent" })

const texts = (messages: Message[]) =>
  messages.map((m) =>
    m.role === "toolResult"
      ? "result"
      : `${m.role}:${m.content.map((b) => (b.type === "text" ? b.text : b.type)).join("|")}`,
  )

async function idle(agent: Agent) {
  while (agent.busy) await Bun.sleep(5)
}

test("a notice delivered while idle starts a turn with it", async () => {
  const { agent, mock, bus, events } = setup([{ text: "noted" }])
  const pending = agent.expectNotice()
  expect(agent.expectedNotices).toBe(1)
  pending.deliver(notice("explorer finished"))
  expect(agent.expectedNotices).toBe(0)
  expect(agent.busy).toBe(true)
  await idle(agent)
  await bus.flush()
  expect(texts(mock.requests[0]!.messages)).toEqual(["user:explorer finished"])
  const start = events.find((e) => e.type === "turn.start")
  expect(start?.type === "turn.start" && start.data.prompt.display?.origin).toBe("subagent")
})

test("a notice delivered during a turn joins it before the next model call", async () => {
  const { agent, mock, bus, events } = setup([{ toolCalls: [{ name: "wait", args: {} }] }, { text: "ok" }])
  const g = gate()
  agent.tools.register(g.tool, "test")
  const done = agent.prompt("go")
  await g.running
  agent.expectNotice().deliver(notice("a"))
  agent.expectNotice().deliver(notice("b"))
  g.release()
  expect((await done).reason).toBe("done")
  await bus.flush()
  expect(mock.requests.length).toBe(2)
  // Batched: both reach the model as one message.
  expect(texts(mock.requests[1]!.messages)).toEqual(["user:go", "assistant:toolCall", "result", "user:a|b"])
  const injected = events.filter((e) => e.type === "turn.steer" && e.data.state === "injected")
  expect(injected.length).toBe(1)
  const m = injected[0]?.type === "turn.steer" ? injected[0].data.message : undefined
  expect(m?.display).toEqual({ text: "◆ a\n◆ b", origin: "subagent" })
  expect(agent.busy).toBe(false)
})

test("a notice the turn did not reach starts the next turn", async () => {
  const { agent, mock, bus } = setup([{ text: "first", delayMs: 20 }, { text: "reacted" }])
  const done = agent.prompt("go")
  await Bun.sleep(5)
  agent.expectNotice().deliver(notice("late"))
  await done
  await Bun.sleep(1)
  await idle(agent)
  await bus.flush()
  expect(texts(mock.requests[1]!.messages)).toEqual(["user:go", "assistant:first", "user:late"])
})

test("a notice an interrupted turn did not reach waits for the next turn", async () => {
  const { agent, mock, bus, events } = setup([
    { toolCalls: [{ name: "wait", args: {} }] },
    { text: "next reply" },
  ])
  const g = gate()
  agent.tools.register(g.tool, "test")
  const done = agent.prompt("go")
  await g.running
  agent.expectNotice().deliver(notice("result"))
  agent.abort()
  g.release()
  expect((await done).reason).toBe("aborted")
  await bus.flush()
  // Not dropped, and no turn of its own after an interrupt.
  expect(events.some((e) => e.type === "turn.steer" && e.data.state === "dropped")).toBe(false)
  expect(agent.busy).toBe(false)
  expect(agent.waitingNotices).toBe(1)
  await agent.prompt("continue")
  expect(texts(mock.requests[1]!.messages).slice(-2)).toEqual(["user:continue", "user:result"])
  expect(agent.waitingNotices).toBe(0)
})

test("only the first deliver or cancel of a notice counts", async () => {
  const { agent, mock } = setup([{ text: "one" }, { text: "two" }])
  const a = agent.expectNotice()
  const b = agent.expectNotice()
  expect(agent.expectedNotices).toBe(2)
  b.cancel()
  b.cancel()
  b.deliver(notice("ignored"))
  expect(agent.expectedNotices).toBe(1)
  a.deliver(notice("x"))
  a.deliver(notice("again"))
  await idle(agent)
  expect(mock.requests.length).toBe(1)
  expect(agent.expectedNotices).toBe(0)
})

test("a notice delivered during a manual compaction starts its turn once that ends", async () => {
  const { agent, mock, bus } = setup([
    { text: "r1" },
    { text: "r2" },
    { text: "r3" },
    { text: "summary", delayMs: 20 },
    { text: "reacted" },
  ])
  await agent.prompt("one")
  await agent.prompt("two")
  await agent.prompt("three")
  const compacting = agent.compact()
  agent.expectNotice().deliver(notice("done meanwhile"))
  expect(agent.turnId).toBeUndefined()
  await compacting
  expect(agent.turnId).toBeDefined()
  await idle(agent)
  await bus.flush()
  expect(texts(mock.requests.at(-1)!.messages).at(-1)).toBe("user:done meanwhile")
})

test("only a top-level session's tools can announce notices", async () => {
  const { agent } = setup([{ toolCalls: [{ name: "peek", args: {} }] }, { text: "ok" }])
  const seen: boolean[] = []
  agent.tools.register(
    defineTool({
      name: "peek",
      description: "",
      parameters: {},
      execute: async (_p, ctx) => {
        seen.push(typeof ctx.session?.expectNotice === "function")
        return textResult("")
      },
    }),
    "test",
  )
  await agent.prompt("look")
  const ai = createAi({
    dialects: [createMockDialect([{ toolCalls: [{ name: "peek", args: {} }] }, { text: "ok" }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const child = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: process.cwd(),
    tools: agent.tools,
    depth: 1,
    parentSessionId: agent.sessionId,
  })
  await child.prompt("look")
  expect(seen).toEqual([true, false])
})
