import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import { createAi, createMockDialect, type MockStep, userMessage } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { noticeInputAgents } from "../src/agent/notice-input.ts"
import { type NoticeRetry, subscribeNoticeRetries } from "../src/agent/notice-retry.ts"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { FrontendProjection } from "../src/frontend/projection.ts"

beforeEach(() => void jest.useFakeTimers())
afterEach(() => void jest.useRealTimers())

const failure: MockStep = { error: { message: "provider down" } }
const notice = () => userMessage("result", { origin: "subagent", text: "Background result" })

async function settle() {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

function fixture(steps: MockStep[], retryMs = [10_000, 30_000]) {
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: process.cwd(),
    systemPrompt: "",
    bus,
    noticeRetryMs: retryMs,
  })
  const projection = new FrontendProjection()
  projection.reconcileNoticeRetry(agent.sessionId, agent.noticeRetry)
  const changes: (NoticeRetry | undefined)[] = []
  const offRetry = subscribeNoticeRetries(bus, (owner, retry) => {
    expect(owner).toBe(agent)
    expect(owner.noticeRetry).toEqual(retry)
    projection.reconcileNoticeRetry(owner.sessionId, retry)
    changes.push(retry)
  })
  const events: AnyEvent[] = []
  const offBus = bus.capture(
    (event) => {
      events.push(event)
      if (event.type === "notice.retry") expect(changes.at(-1)?.attempt).toBe(event.data.attempt)
      projection.capture(event)
    },
    () => projection.fail(),
  )
  return {
    agent,
    mock,
    bus,
    projection,
    changes,
    events,
    retries: () => projection.snapshot().events.filter((event) => event.type === "notice.retry"),
    async close() {
      await agent.dispose()
      offRetry()
      offBus()
    },
  }
}

test("retry schedule metadata survives reconciliation until explicit cancellation synchronously removes it", async () => {
  const f = fixture([failure])
  try {
    f.agent.expectNotice().deliver(notice())
    await f.agent.currentTurn
    const scheduled = f.agent.noticeRetry!
    expect(scheduled.at).toBe(Date.now() + 10_000)
    expect(f.changes).toEqual([scheduled])
    expect(Object.isFrozen(f.changes[0])).toBe(true)
    f.projection.reconcileNoticeRetry(f.agent.sessionId, f.agent.noticeRetry)
    f.projection.reconcileTurns(new Map([[f.agent.sessionId, undefined]]))
    expect(f.retries()).toMatchObject([
      { data: { attempt: 1, attempts: 2, delayMs: 10_000, error: "provider down" } },
    ])
    f.agent.cancelNoticeRetry()
    expect(f.changes).toEqual([scheduled, undefined])
    expect(f.retries()).toEqual([])
    f.agent.cancelNoticeRetry()
    expect(f.changes).toHaveLength(2)
    jest.advanceTimersByTime(100_000)
    await settle()
    expect(f.mock.requests).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test("starting a new user turn clears retry activity before the turn can settle successfully", async () => {
  const gate = Promise.withResolvers<void>()
  const f = fixture([failure, { text: "handled", hold: { chunks: 0, until: gate.promise } }])
  try {
    f.agent.expectNotice().deliver(notice())
    await f.agent.currentTurn
    const followup = f.agent.prompt("continue")
    expect(f.agent.noticeRetry).toBeUndefined()
    expect(f.changes.at(-1)).toBeUndefined()
    expect(f.retries()).toEqual([])
    gate.resolve()
    expect((await followup).reason).toBe("done")
    expect(f.retries()).toEqual([])
  } finally {
    gate.resolve()
    await f.close()
  }
})

test("timer firing clears retry activity even when a hold prevents a compensating turn.start", async () => {
  const gate = Promise.withResolvers<void>()
  const f = fixture([failure, { text: "handled" }])
  let hold: Promise<unknown> | undefined
  try {
    f.agent.expectNotice().deliver(notice())
    await f.agent.currentTurn
    hold = f.agent.hold("compaction", () => gate.promise)
    const starts = f.events.filter((event) => event.type === "turn.start").length
    jest.advanceTimersByTime(10_000)
    expect(f.agent.noticeRetry).toBeUndefined()
    expect(f.retries()).toEqual([])
    expect(f.agent.waitingNotices).toBe(1)
    expect(f.events.filter((event) => event.type === "turn.start")).toHaveLength(starts)
    gate.resolve()
    await hold
    await f.agent.currentTurn
    expect(f.mock.requests).toHaveLength(2)
  } finally {
    gate.resolve()
    await hold
    await f.close()
  }
})

test("timer firing and retry exhaustion publish authoritative clears without retaining old attempts", async () => {
  const f = fixture([failure, failure, failure])
  try {
    f.agent.expectNotice().deliver(notice())
    await f.agent.currentTurn
    jest.advanceTimersByTime(10_000)
    await settle()
    expect(f.changes.slice(0, 2).map((retry) => retry?.attempt)).toEqual([1, undefined])
    expect(f.agent.noticeRetry?.attempt).toBe(2)
    expect(f.retries()).toMatchObject([{ data: { attempt: 2, attempts: 2, error: "provider down" } }])
    jest.advanceTimersByTime(30_000)
    await settle()
    expect(f.agent.noticeRetry).toBeUndefined()
    expect(f.retries()).toEqual([])
    expect(f.changes.map((retry) => retry?.attempt)).toEqual([1, undefined, 2, undefined])
    expect(f.mock.requests).toHaveLength(3)
  } finally {
    await f.close()
  }
})

test("retry capture bootstraps the actual getter, isolates private buses, and contains observer failures", async () => {
  const f = fixture([failure])
  const privateBus = new EventBus()
  const privateChanges: unknown[] = []
  const offPrivate = subscribeNoticeRetries(privateBus, (_agent, retry) => privateChanges.push(retry))
  const errors: unknown[] = []
  const captureFailure = new Error("host retry capture failed")
  const offFailure = subscribeNoticeRetries(
    f.bus,
    () => {
      throw captureFailure
    },
    (error) => errors.push(error),
  )
  try {
    f.agent.expectNotice().deliver(notice())
    await f.agent.currentTurn
    expect(noticeInputAgents(f.bus).map((agent) => agent.noticeRetry)).toEqual([f.agent.noticeRetry])
    expect(privateChanges).toEqual([])
    expect(errors).toEqual([captureFailure])
    offFailure()
    f.agent.cancelNoticeRetry()
    expect(errors).toHaveLength(1)
    expect(f.agent.noticeRetry).toBeUndefined()
  } finally {
    offFailure()
    offPrivate()
    await f.close()
  }
})

test("retry activity follows schedule identity and cannot resurrect after cancellation or owner retirement", () => {
  const bus = new EventBus()
  const projection = new FrontendProjection()
  bus.capture(
    (event) => projection.capture(event),
    () => projection.fail(),
  )
  const retry = { attempt: 1, at: Date.now() + 10_000 }
  const data = { attempt: 1, attempts: 2, delayMs: 10_000, error: "original" }
  projection.reconcileNoticeRetry("root", retry)
  bus.emit("notice.retry", data, { sessionId: "root" })
  projection.reconcileNoticeRetry("root", { ...retry })
  expect(projection.snapshot().events).toHaveLength(1)
  projection.reconcileNoticeRetry("root", { ...retry, at: retry.at + 1 })
  expect(projection.snapshot().events).toEqual([])
  bus.emit("notice.retry", { ...data, error: "replacement" }, { sessionId: "root" })
  projection.reconcileNoticeRetry("root", undefined)
  bus.emit("notice.retry", data, { sessionId: "root" })
  expect(projection.snapshot().events).toEqual([])
  projection.reconcileNoticeRetry("root", retry)
  bus.emit("notice.retry", data, { sessionId: "root" })
  projection.reconcileTurns(new Map())
  expect(projection.snapshot().events).toEqual([])
})

test("cancelling oversized retry metadata recovers projection without clearing unrelated corruption", () => {
  const bus = new EventBus()
  const projection = new FrontendProjection({ bytes: 512, events: 100 })
  bus.capture(
    (event) => projection.capture(event),
    () => projection.fail(),
  )
  projection.reconcileNoticeRetry("root", { attempt: 1, at: Date.now() + 10_000 })
  bus.emit(
    "notice.retry",
    { attempt: 1, attempts: 1, delayMs: 10_000, error: "x".repeat(1024) },
    { sessionId: "root" },
  )
  expect(() => projection.snapshot()).toThrow("recovery")
  projection.reconcileNoticeRetry("root", undefined)
  expect(projection.snapshot().events).toEqual([])
  projection.fail()
  projection.reconcileNoticeRetry("root", undefined)
  expect(() => projection.snapshot()).toThrow("recovery")
})
