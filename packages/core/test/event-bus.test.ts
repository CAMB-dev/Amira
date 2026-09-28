import { expect, test } from "bun:test"
import type { AnyEvent } from "@amira/api"
import { EventBus } from "../src/event-bus.ts"

const meta = { sessionId: "s1" }

test("delivers events in order with increasing seq, without waiting for subscribers", async () => {
  const bus = new EventBus()
  const seen: AnyEvent[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  bus.subscribe(async (e) => {
    await gate
    seen.push(e)
  })
  bus.emit("turn.start", { prompt: { role: "user", content: [] } }, meta)
  bus.emit("turn.end", { reason: "done", steps: 1 }, meta)
  // emit returned even though the subscriber is still blocked
  expect(seen).toHaveLength(0)
  release()
  await bus.flush()
  expect(seen.map((e) => e.type)).toEqual(["turn.start", "turn.end"])
  expect(seen[0]!.seq).toBeLessThan(seen[1]!.seq)
})

test("a failing subscriber does not affect others", async () => {
  const errors: unknown[] = []
  const bus = new EventBus((err) => errors.push(err))
  const seen: string[] = []
  bus.subscribe(() => {
    throw new Error("boom")
  })
  bus.subscribe((e) => void seen.push(e.type))
  bus.emit("turn.end", { reason: "done", steps: 0 }, meta)
  await bus.flush()
  expect(seen).toEqual(["turn.end"])
  expect(errors).toHaveLength(1)
})

test("overflow drops streaming deltas first and reports events.lost", async () => {
  const bus = new EventBus()
  const seen: AnyEvent[] = []
  bus.subscribe((e) => void seen.push(e), { maxQueue: 3 })
  // Emits are synchronous and the queue drains on a later microtask, so all six hit a queue of 3.
  bus.emit("turn.start", { prompt: { role: "user", content: [] } }, meta)
  bus.emit("message.delta", { kind: "text", text: "a" }, meta)
  bus.emit("message.delta", { kind: "text", text: "b" }, meta)
  bus.emit(
    "message.end",
    { message: { role: "assistant", content: [], model: { provider: "p", model: "m" } } },
    meta,
  ) // full: drops delta "a"
  bus.emit("turn.end", { reason: "done", steps: 1 }, meta) // full: drops delta "b"
  bus.emit("message.delta", { kind: "text", text: "c" }, meta) // full: the incoming delta is dropped
  await bus.flush()
  expect(seen.map((e) => e.type)).toEqual(["events.lost", "turn.start", "message.end", "turn.end"])
  expect((seen[0] as Extract<AnyEvent, { type: "events.lost" }>).data.dropped).toBe(3)
})

test("type filters and unsubscribe", async () => {
  const bus = new EventBus()
  const seen: string[] = []
  const off = bus.subscribe((e) => void seen.push(e.type), { types: ["turn.end"] })
  bus.emit("turn.start", { prompt: { role: "user", content: [] } }, meta)
  bus.emit("turn.end", { reason: "done", steps: 0 }, meta)
  await bus.flush()
  off()
  bus.emit("turn.end", { reason: "done", steps: 0 }, meta)
  await bus.flush()
  expect(seen).toEqual(["turn.end"])
})
