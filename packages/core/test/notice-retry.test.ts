import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import { createAi, createMockDialect, type Message, type MockStep, userMessage } from "@amira/ai"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { Agent, NOTICE_RETRY_MS } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"

beforeEach(() => void jest.useFakeTimers())
afterEach(() => void jest.useRealTimers())

function setup(steps: MockStep[]) {
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const agent = new Agent({ ai, model: ai.model("mock/test"), cwd: process.cwd(), systemPrompt: "", bus })
  return { agent, mock, bus, events }
}

const notice = (text: string) => userMessage(text, { text: `◆ ${text}`, origin: "subagent" })
const fail: MockStep = { error: { message: "provider down" } }

/** Lets promise chains (the mock stream, turn bookkeeping, event delivery) run. */
async function settle() {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

const lastUser = (messages: Message[]) => {
  const m = messages.findLast((x) => x.role === "user")
  return m?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? ""
}

const retries = (events: AnyEvent[]) =>
  events.flatMap((e) => (e.type === "notice.retry" ? [[e.data.attempt, e.data.delayMs]] : []))

test("a failed turn carrying notices sends them again after 10 s, 30 s and 90 s, then stops", async () => {
  const { agent, mock, events } = setup([fail, fail, fail, fail, { text: "finally" }])
  agent.expectNotice().deliver(notice("result"))
  await settle()
  expect(mock.requests.length).toBe(1)
  expect(agent.noticeRetry?.attempt).toBe(1)
  jest.advanceTimersByTime(9_999)
  await settle()
  expect(mock.requests.length).toBe(1)
  jest.advanceTimersByTime(1)
  await settle()
  expect(mock.requests.length).toBe(2)
  expect(lastUser(mock.requests[1]!.messages)).toContain("failed before you handled the results")
  jest.advanceTimersByTime(30_000)
  await settle()
  expect(mock.requests.length).toBe(3)
  jest.advanceTimersByTime(90_000)
  await settle()
  expect(mock.requests.length).toBe(4)
  // Three resends failed: nothing more until the user writes.
  expect(agent.noticeRetry).toBeUndefined()
  jest.advanceTimersByTime(600_000)
  await settle()
  expect(mock.requests.length).toBe(4)
  expect(retries(events)).toEqual(NOTICE_RETRY_MS.map((ms, i) => [i + 1, ms]))
  expect(agent.busy).toBe(false)
})

test("a success resets the retries", async () => {
  const { agent, mock, events } = setup([fail, { text: "handled" }, fail, { text: "handled too" }])
  agent.expectNotice().deliver(notice("one"))
  await settle()
  jest.advanceTimersByTime(10_000)
  await settle()
  expect(mock.requests.length).toBe(2)
  expect(agent.noticeRetry).toBeUndefined()
  agent.expectNotice().deliver(notice("two"))
  await settle()
  // Counting starts over: the first delay again.
  expect(retries(events)).toEqual([
    [1, 10_000],
    [1, 10_000],
  ])
})

test("a message from the user takes held notices along and cancels the resend", async () => {
  let release!: () => void
  const released = new Promise<void>((r) => {
    release = r
  })
  const { agent, mock } = setup([{ toolCalls: [{ name: "wait", args: {} }] }, fail, { text: "both" }])
  agent.tools.register(
    defineTool({
      name: "wait",
      description: "",
      parameters: {},
      execute: () => released.then(() => textResult("ok")),
    }),
    "test",
  )
  const turn = agent.prompt("go")
  await settle()
  jest.advanceTimersByTime(1)
  await settle()
  agent.expectNotice().deliver(notice("held"))
  release()
  await turn
  await settle()
  // The failing call got the notice... and failed; it is due again.
  expect(agent.noticeRetry?.attempt).toBe(1)
  const next = agent.prompt("user again")
  expect(agent.noticeRetry).toBeUndefined()
  await next
  jest.advanceTimersByTime(600_000)
  await settle()
  expect(mock.requests.length).toBe(3)
  expect(lastUser(mock.requests[2]!.messages)).toBe("user again")
})

test("a notice a failed turn never reached is sent with the user's message if that comes first", async () => {
  const { agent, mock } = setup([{ error: { message: "down" }, delayMs: 100 }, { text: "ok" }])
  const turn = agent.prompt("go")
  await settle()
  agent.expectNotice().deliver(notice("unsent"))
  jest.advanceTimersByTime(100)
  expect((await turn).reason).toBe("error")
  await settle()
  expect(agent.waitingNotices).toBe(1)
  expect(agent.noticeRetry?.attempt).toBe(1)
  jest.advanceTimersByTime(5_000)
  await agent.prompt("hi")
  expect(agent.noticeRetry).toBeUndefined()
  const users = mock.requests[1]!.messages.filter((m) => m.role === "user")
  expect(
    users.slice(-2).map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join("")),
  ).toEqual(["hi", "unsent"])
  jest.advanceTimersByTime(600_000)
  await settle()
  expect(mock.requests.length).toBe(2)
})

test("notices held by an interrupt are not sent again by themselves", async () => {
  const { agent, mock, events } = setup([{ text: "slow", delayMs: 1000 }, { text: "later" }])
  const turn = agent.prompt("go")
  await settle()
  agent.expectNotice().deliver(notice("kept"))
  agent.abort()
  expect((await turn).reason).toBe("aborted")
  await settle()
  expect(agent.noticeRetry).toBeUndefined()
  jest.advanceTimersByTime(600_000)
  await settle()
  expect(mock.requests.length).toBe(1)
  expect(agent.waitingNotices).toBe(1)
  expect(retries(events)).toEqual([])
})

test("cancelNoticeRetry drops the scheduled resend", async () => {
  const { agent, mock } = setup([fail, { text: "never" }])
  agent.expectNotice().deliver(notice("x"))
  await settle()
  expect(agent.noticeRetry).toBeDefined()
  agent.cancelNoticeRetry()
  jest.advanceTimersByTime(600_000)
  await settle()
  expect(mock.requests.length).toBe(1)
})
