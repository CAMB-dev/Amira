import { expect, test } from "bun:test"
import { userMessage } from "@amira/ai"
import type { NoticeInput, NoticeInputSnapshot } from "../src/agent/notice-input.ts"
import { EventBus } from "../src/event-bus.ts"
import { FrontendProjection } from "../src/frontend/projection.ts"

const meta = { sessionId: "root", turnId: "turn" }

function fixture(bytes = 16 * 1024 * 1024) {
  const bus = new EventBus()
  const projection = new FrontendProjection({ bytes, events: 100 })
  bus.capture(
    (event) => projection.capture(event),
    () => projection.fail(),
  )
  const queue = (queue: readonly NoticeInput[], expected = 0) => {
    const snapshot: NoticeInputSnapshot = { queue, expected }
    projection.reconcileNotices(meta.sessionId, snapshot)
  }
  queue([])
  return { bus, projection, queue }
}

test("authoritative notice removals reconcile direct wake and duplicate admissions independently", () => {
  const f = fixture()
  const message = userMessage("duplicate notice")
  const entries = [
    { id: "one", message },
    { id: "two", message },
  ]
  f.queue(entries.slice(0, 1))
  f.bus.emit("turn.steer", { message, state: "queued" }, meta)
  f.queue(entries)
  f.bus.emit("turn.steer", { message, state: "queued" }, meta)
  f.queue(entries.slice(1))
  expect(f.projection.snapshot().events).toHaveLength(1)
  f.queue([])
  expect(f.projection.snapshot().events).toEqual([])
})

test("authoritative notices cannot be consumed by a coincidentally identical steering event", () => {
  const f = fixture()
  const message = userMessage("same text, different owner")
  f.queue([{ id: "notice", message }])
  f.bus.emit("turn.steer", { message, state: "queued" }, meta)
  f.bus.emit("turn.steer", { message, state: "queued" }, meta)
  f.bus.emit("turn.steer", { message, state: "dropped" }, meta)
  expect(f.projection.snapshot().events).toHaveLength(1)
  f.queue([])
  expect(f.projection.snapshot().events).toEqual([])
})

test("notice overflow survives unrelated successful or aborted turns until its inbox admission drains", () => {
  const f = fixture(1024)
  const message = userMessage("x".repeat(2048))
  const entries = [{ id: "oversized", message }]
  f.queue(entries)
  f.bus.emit("turn.steer", { message, state: "queued" }, meta)
  for (const reason of ["aborted", "done"] as const) {
    f.bus.emit("turn.end", { reason, steps: 1 }, meta)
    f.queue(entries)
    expect(() => f.projection.snapshot()).toThrow("recovery")
  }
  f.queue([])
  expect(f.projection.snapshot().events).toEqual([])
})

test("removing overflowing notices does not clear unrelated held-input overflow markers", () => {
  const f = fixture(1024)
  const message = userMessage("x".repeat(2048))
  f.queue([{ id: "oversized", message }])
  f.bus.emit("turn.steer", { message, state: "queued" }, meta)
  f.bus.emit("turn.steer", { message, state: "queued" }, meta)
  f.queue([])
  expect(() => f.projection.snapshot()).toThrow("recovery")
  f.bus.emit("turn.steer", { message, state: "dropped" }, meta)
  expect(f.projection.snapshot().events).toEqual([])
})

test("selection recovery quarantines unobserved live work and notices instead of fabricating completeness", () => {
  const f = fixture()
  f.projection.fail()
  f.projection.reconcileNotices("quiet", {
    queue: [{ id: "pending", message: userMessage("not consumed") }],
    expected: 0,
  })
  f.projection.reconcileTurns(
    new Map([
      ["quiet", undefined],
      ["running", "live-turn"],
    ]),
  )
  expect(() => f.projection.snapshot()).toThrow("recovery")
  f.bus.emit("turn.end", { reason: "aborted", steps: 1 }, { sessionId: "running", turnId: "live-turn" })
  expect(() => f.projection.snapshot()).toThrow("recovery")
  f.projection.reconcileNotices("quiet", { queue: [], expected: 0 })
  expect(f.projection.failed).toBe(false)
})
