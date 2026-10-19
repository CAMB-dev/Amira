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
  expect(seen.map((e) => e.type)).toEqual(["turn.start", "message.end", "events.lost", "turn.end"])
  expect((seen[2] as Extract<AnyEvent, { type: "events.lost" }>).data.dropped).toBe(3)
  const seqs = seen.map((e) => e.seq)
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
})

test("filtered subscribers never receive events.lost unless they ask for it", async () => {
  const bus = new EventBus()
  const seen: string[] = []
  bus.subscribe((e) => void seen.push(e.type), { types: ["turn.end"], maxQueue: 1 })
  bus.emit("turn.end", { reason: "done", steps: 0 }, meta)
  bus.emit("turn.end", { reason: "done", steps: 1 }, meta)
  await bus.flush()
  expect(seen).toEqual(["turn.end"])
})

test("a throwing error handler neither crashes nor wedges the subscriber", async () => {
  const bus = new EventBus(() => {
    throw new Error("handler broke")
  })
  let calls = 0
  bus.subscribe(() => {
    calls++
    throw new Error("subscriber broke")
  })
  bus.emit("turn.end", { reason: "done", steps: 0 }, meta)
  await bus.flush()
  bus.emit("turn.end", { reason: "done", steps: 0 }, meta)
  await bus.flush()
  expect(calls).toBe(2)
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

test("host capture precedes lossy queues and does not capture subscriber-local loss markers", async () => {
  const bus = new EventBus()
  const captured: AnyEvent[] = []
  const delivered: AnyEvent[] = []
  const off = bus.capture(
    (event) => captured.push(structuredClone(event)),
    () => {},
  )
  bus.subscribe((event) => void delivered.push(event), { maxQueue: 1 })
  for (let i = 0; i < 20; i++) bus.emit("message.delta", { kind: "text", text: `${i}` }, meta)
  expect(captured).toHaveLength(20)
  expect(delivered).toHaveLength(0)
  off()
  bus.emit("turn.end", { reason: "done", steps: 1 }, meta)
  await bus.flush()
  expect(captured).toHaveLength(20)
  expect(captured.some((event) => event.type === "events.lost")).toBe(false)
  expect(delivered.some((event) => event.type === "events.lost")).toBe(true)
})

test("capture failure explicitly notifies its host without breaking subscribers or other captures", async () => {
  const bus = new EventBus()
  const failures: unknown[] = []
  let captures = 0
  let deliveries = 0
  bus.capture(
    () => {
      throw new Error("projection failed")
    },
    (error) => {
      failures.push(error)
    },
  )
  bus.capture(
    () => {
      captures++
    },
    () => {},
  )
  bus.subscribe(() => {
    deliveries++
  })
  bus.emit("turn.end", { reason: "done", steps: 1 }, meta)
  expect(failures).toHaveLength(1)
  expect(captures).toBe(1)
  await bus.flush()
  expect(deliveries).toBe(1)
})
