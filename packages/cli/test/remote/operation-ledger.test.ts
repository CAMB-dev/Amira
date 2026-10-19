import { expect, test } from "bun:test"
import { RemoteReplyError } from "../../src/remote/errors.ts"
import { OperationLedger, type OperationLedgerOptions } from "../../src/server/operation-ledger.ts"

const scope = { clientId: "client-a", controllerToken: "token-a" }
const payload = { op: "turn.prompt", params: { message: "hello" } }

function fixture(options: OperationLedgerOptions = {}) {
  let time = 1_000
  const ledger = new OperationLedger({
    retentionMs: 100,
    maxEntries: 2,
    maxIds: 4,
    now: () => time,
    ...options,
  })
  return { ledger, at: (value: number) => (time = value) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

test("admission precedes execution and concurrent retries share the exact promise", async () => {
  const { ledger } = fixture()
  const pending = deferred<string>()
  let effects = 0
  const first = ledger.run(scope, "op-1", payload, () => {
    effects++
    return pending.promise
  })
  const retry = ledger.run<string>(scope, "op-1", payload, () => {
    throw new Error("A retry must never execute")
  })
  expect(effects).toBe(1)
  expect(retry).toBe(first)
  pending.resolve("accepted")
  expect(await first).toBe("accepted")
  expect(await retry).toBe("accepted")
})

test("a lost result is replayed without executing the operation again", async () => {
  const { ledger } = fixture()
  let effects = 0
  const execute = () => ({ effect: ++effects })
  const lost = ledger.run(scope, "op-1", payload, execute)
  await lost // The first transport disappears without delivering the reply.
  const retry = ledger.run({ ...scope }, "op-1", payload, execute)
  expect(retry).toBe(lost)
  expect(await retry).toEqual({ effect: 1 })
  expect(effects).toBe(1)
})

test("canonical JSON ignores object-key order but preserves array order and value types", async () => {
  const { ledger } = fixture()
  const first = ledger.run(scope, "op-1", { z: [{ b: 2, a: 1 }], a: -0 }, () => "ok")
  const same = ledger.run(scope, "op-1", { a: 0, z: [{ a: 1, b: 2 }] }, () => "unexpected")
  expect(same).toBe(first)
  expect(await same).toBe("ok")
  for (const changed of [
    { a: 0, z: [{ a: 1, b: "2" }] },
    { a: 0, z: [{ a: 1, b: 2 }, null] },
    { a: 0, z: [] },
  ]) {
    await expect(ledger.run(scope, "op-1", changed, () => "unexpected")).rejects.toMatchObject({
      code: "operation_conflict",
    })
  }
  const array = ledger.run(scope, "array", [1, 2], () => "ordered")
  await expect(ledger.run(scope, "array", [2, 1], () => "unexpected")).rejects.toMatchObject({
    code: "operation_conflict",
  })
  expect(await array).toBe("ordered")
})

test("changed operation or params reject both running and settled retries before execution", async () => {
  const { ledger } = fixture()
  const pending = deferred<string>()
  const first = ledger.run(scope, "op-1", payload, () => pending.promise)
  let retries = 0
  const execute = () => ++retries
  await expect(ledger.run(scope, "op-1", { ...payload, op: "turn.steer" }, execute)).rejects.toMatchObject({
    code: "operation_conflict",
  })
  pending.resolve("done")
  await first
  await expect(
    ledger.run(scope, "op-1", { ...payload, params: { message: "different" } }, execute),
  ).rejects.toMatchObject({ code: "operation_conflict" })
  expect(retries).toBe(0)
})

test("ids are scoped to both the controller token and client identity, not connection generation", async () => {
  const { ledger } = fixture({ maxEntries: 3 })
  let effects = 0
  const execute = () => ++effects
  expect(await ledger.run(scope, "op-1", payload, execute)).toBe(1)
  expect(await ledger.run({ ...scope, clientId: "client-b" }, "op-1", payload, execute)).toBe(2)
  expect(await ledger.run({ ...scope, controllerToken: "token-b" }, "op-1", payload, execute)).toBe(3)
  expect(await ledger.run({ ...scope }, "op-1", payload, execute)).toBe(1)
  expect(effects).toBe(3)
})

test("scope components and operation ids cannot collide through separator characters", async () => {
  const { ledger } = fixture({ maxEntries: 3 })
  expect(await ledger.run({ clientId: "a:b", controllerToken: "c" }, "d", null, () => 1)).toBe(1)
  expect(await ledger.run({ clientId: "a", controllerToken: "b:c" }, "d", null, () => 2)).toBe(2)
  expect(await ledger.run({ clientId: "a", controllerToken: "b" }, "c:d", null, () => 3)).toBe(3)
})

for (const synchronous of [true, false]) {
  test(`operation errors are retained and replayed, including ${synchronous ? "sync" : "async"} failures`, async () => {
    const { ledger } = fixture()
    const failure = new RemoteReplyError("agent_busy", "Agent is busy")
    let effects = 0
    const first = ledger.run(scope, "op-1", payload, () => {
      effects++
      if (synchronous) throw failure
      return Promise.reject(failure)
    })
    await expect(first).rejects.toBe(failure)
    const retry = ledger.run(scope, "op-1", payload, () => {
      effects++
      return "unexpected"
    })
    expect(retry).toBe(first)
    await expect(retry).rejects.toBe(failure)
    expect(effects).toBe(1)
  })
}

test("failed effects also expire to tombstones and can never be executed again", async () => {
  const { ledger, at } = fixture()
  let effects = 0
  await expect(
    ledger.run(scope, "op-1", payload, () => {
      effects++
      throw new Error("failed after an effect")
    }),
  ).rejects.toThrow("failed after an effect")
  at(1_100)
  await expect(ledger.run(scope, "op-1", payload, () => ++effects)).rejects.toMatchObject({
    code: "operation_expired",
  })
  expect(effects).toBe(1)
})

test("retained results last until the exact expiry boundary, then all reuse fails closed", async () => {
  const { ledger, at } = fixture()
  const first = ledger.run(scope, "op-1", payload, () => "result")
  await first
  at(1_099)
  expect(ledger.run(scope, "op-1", payload, () => "unexpected")).toBe(first)
  at(1_100)
  expect(ledger.prune()).toBe(1)
  expect(ledger.prune()).toBe(0)
  for (const value of [payload, { different: true }]) {
    await expect(ledger.run(scope, "op-1", value, () => "unexpected")).rejects.toMatchObject({
      code: "operation_expired",
    })
  }
  expect(await ledger.run(scope, "op-2", payload, () => "new")).toBe("new")
})

test("running entries never expire or evict, and retention starts only on settlement", async () => {
  const { ledger, at } = fixture({ maxEntries: 1 })
  const pending = deferred<string>()
  const first = ledger.run(scope, "op-1", payload, () => pending.promise)
  at(10_000)
  expect(ledger.prune()).toBe(0)
  expect(ledger.run(scope, "op-1", payload, () => "unexpected")).toBe(first)
  let rejectedEffects = 0
  await expect(ledger.run(scope, "op-2", payload, () => ++rejectedEffects)).rejects.toMatchObject({
    code: "limit_exceeded",
  })
  pending.resolve("done")
  await first
  at(10_099)
  expect(ledger.run(scope, "op-1", payload, () => "unexpected")).toBe(first)
  at(10_100)
  expect(ledger.prune()).toBe(1)
  // A capacity rejection did not admit this id or invoke its callback.
  expect(rejectedEffects).toBe(0)
  expect(await ledger.run(scope, "op-2", payload, () => ++rejectedEffects)).toBe(1)
})

test("full retained capacity refuses new ids but still replays accepted ones", async () => {
  const { ledger } = fixture({ maxEntries: 1 })
  const first = ledger.run(scope, "op-1", payload, () => "done")
  await first
  await expect(ledger.run(scope, "op-2", payload, () => "unexpected")).rejects.toMatchObject({
    code: "limit_exceeded",
  })
  expect(ledger.run(scope, "op-1", payload, () => "unexpected")).toBe(first)
})

test("bounded tombstones exhaust fail-closed across clients without forgetting any accepted id", async () => {
  const { ledger, at } = fixture({ maxEntries: 1, maxIds: 2 })
  let effects = 0
  await ledger.run(scope, "op-1", payload, () => ++effects)
  at(1_100)
  await ledger.run(scope, "op-2", payload, () => ++effects)
  at(1_200)
  expect(ledger.prune()).toBe(1)
  for (const id of ["op-1", "op-2"]) {
    await expect(ledger.run(scope, id, payload, () => ++effects)).rejects.toMatchObject({
      code: "operation_expired",
    })
  }
  for (const client of [scope, { ...scope, clientId: "client-b" }]) {
    await expect(ledger.run(client, "op-3", payload, () => ++effects)).rejects.toMatchObject({
      code: "limit_exceeded",
    })
  }
  expect(effects).toBe(2)
})

test("the admitted payload is an immutable JSON snapshot, not a mutable caller reference", async () => {
  const { ledger } = fixture()
  const original = { nested: { value: 1 }, list: ["first"] }
  const first = ledger.run(scope, "op-1", original, (accepted) => {
    expect(Object.isFrozen(accepted)).toBe(true)
    expect(accepted).toEqual({ nested: { value: 1 }, list: ["first"] })
    if (!accepted || typeof accepted !== "object" || Array.isArray(accepted))
      throw new Error("Expected object")
    expect(Object.isFrozen(accepted.nested)).toBe(true)
    expect(Object.isFrozen(accepted.list)).toBe(true)
    return "done"
  })
  original.nested.value = 2
  original.list.push("later")
  expect(await first).toBe("done")
  await expect(ledger.run(scope, "op-1", original, () => "unexpected")).rejects.toMatchObject({
    code: "operation_conflict",
  })
})

test("reentrant execution sees the admitted promise rather than invoking the effect twice", async () => {
  const { ledger } = fixture()
  let retry: Promise<string> | undefined
  const first = ledger.run(scope, "op-1", payload, () => {
    retry = ledger.run(scope, "op-1", payload, () => "unexpected")
    return "done"
  })
  expect(await first).toBe("done")
  expect(retry).toBe(first)
})

test("reentrant JSON snapshotting cannot overwrite an already admitted operation", async () => {
  const { ledger } = fixture()
  const original = { value: 1 }
  let nested: Promise<number> | undefined
  let effects = 0
  const proxy = new Proxy(original, {
    getOwnPropertyDescriptor(target, key) {
      nested ??= ledger.run(scope, "op-1", original, () => ++effects)
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  const outer = ledger.run(scope, "op-1", proxy, () => ++effects)
  expect(outer).toBe(nested!)
  expect(await outer).toBe(1)
  expect(effects).toBe(1)
})

test("malformed or oversized payloads are rejected before admission without invoking getters", async () => {
  const { ledger } = fixture({ maxPayloadBytes: 64 })
  let reads = 0
  const accessor = {
    get value() {
      reads++
      return "bad"
    },
  }
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  for (const value of [accessor, cycle, undefined, Number.NaN, new Date(), { value: undefined }]) {
    await expect(ledger.run(scope, "op-1", value, () => "unexpected")).rejects.toMatchObject({
      code: "invalid_frame",
    })
  }
  expect(reads).toBe(0)
  await expect(ledger.run(scope, "op-1", "é".repeat(32), () => "unexpected")).rejects.toMatchObject({
    code: "limit_exceeded",
  })
  expect(await ledger.run(scope, "op-1", null, () => "valid")).toBe("valid")
})

test("aggregate UTF-8 payload bytes reject before effects without evicting running entries", async () => {
  const { ledger, at } = fixture({ maxBytes: 12, maxEntries: 3 })
  const pending = deferred<number>()
  let effects = 0
  // Each canonical payload is six UTF-8 bytes, including the JSON quotes.
  const first = ledger.run(scope, "op-1", "éé", () => {
    effects++
    return pending.promise
  })
  const second = ledger.run(scope, "op-2", "éé", () => {
    effects++
    return pending.promise
  })
  at(10_000)
  expect(ledger.prune()).toBe(0)
  await expect(ledger.run(scope, "op-3", null, () => ++effects)).rejects.toMatchObject({
    code: "limit_exceeded",
  })
  expect(ledger.run(scope, "op-1", "éé", () => ++effects)).toBe(first)
  expect(effects).toBe(2)
  pending.resolve(1)
  // Neither result fits, but the accepted ids remain failures rather than being evicted.
  await expect(first).rejects.toMatchObject({ code: "limit_exceeded" })
  await expect(second).rejects.toMatchObject({ code: "limit_exceeded" })
  at(10_100)
  expect(ledger.prune()).toBe(2)
  expect(await ledger.run(scope, "op-3", null, () => ++effects)).toBe(3)
})

test("a single payload exceeding the aggregate budget is rejected before execution", async () => {
  const { ledger } = fixture({ maxBytes: 8, maxPayloadBytes: 100 })
  let effects = 0
  await expect(ledger.run(scope, "op-1", "é".repeat(4), () => ++effects)).rejects.toMatchObject({
    code: "limit_exceeded",
  })
  expect(effects).toBe(0)
  // Admission rejection does not consume the id or its byte reservation.
  expect(await ledger.run(scope, "op-1", null, () => ++effects)).toBe(1)
})

test("retained result bytes count toward admission and are released on expiry", async () => {
  const { ledger, at } = fixture({ maxBytes: 12 })
  // Four payload bytes plus eight result bytes exactly fill the budget.
  const first = ledger.run(scope, "op-1", null, () => "ééé")
  expect(await first).toBe("ééé")
  let effects = 0
  await expect(ledger.run(scope, "op-2", null, () => ++effects)).rejects.toMatchObject({
    code: "limit_exceeded",
  })
  expect(effects).toBe(0)
  expect(ledger.run(scope, "op-1", null, () => "unexpected")).toBe(first)
  at(1_100)
  expect(ledger.prune()).toBe(1)
  expect(ledger.prune()).toBe(0)
  expect(await ledger.run(scope, "op-2", null, () => ++effects)).toBe(1)
})

test("an oversized terminal result becomes a retained failure and never repeats the mutation", async () => {
  const { ledger, at } = fixture({ maxBytes: 12 })
  let effects = 0
  const execute = () => {
    effects++
    return "x".repeat(100)
  }
  const first = ledger.run(scope, "op-1", null, execute)
  await expect(first).rejects.toMatchObject({ code: "limit_exceeded" })
  const retry = ledger.run(scope, "op-1", null, execute)
  expect(retry).toBe(first)
  await expect(retry).rejects.toMatchObject({ code: "limit_exceeded" })
  await expect(ledger.run(scope, "op-1", true, execute)).rejects.toMatchObject({
    code: "operation_conflict",
  })
  // The rejected result was not retained or charged; only its canonical payload remains.
  expect(await ledger.run(scope, "op-2", null, () => 1)).toBe(1)
  expect(effects).toBe(1)
  at(1_100)
  expect(ledger.prune()).toBe(2)
  await expect(ledger.run(scope, "op-1", null, execute)).rejects.toMatchObject({
    code: "operation_expired",
  })
  expect(await ledger.run(scope, "op-3", null, () => "123456")).toBe("123456")
  expect(effects).toBe(1)
})

test("ordinary retained errors consume bytes and release them on expiry", async () => {
  const { ledger, at } = fixture({ maxBytes: 16 * 1024 })
  const failure = new RemoteReplyError("agent_busy", "x".repeat(12 * 1024))
  failure.stack = ""
  const first = ledger.run(scope, "op-1", null, () => {
    throw failure
  })
  await expect(first).rejects.toBe(failure)
  const large = "x".repeat(8 * 1024)
  let effects = 0
  await expect(ledger.run(scope, "op-2", large, () => ++effects)).rejects.toMatchObject({
    code: "limit_exceeded",
  })
  expect(effects).toBe(0)
  at(1_100)
  expect(ledger.prune()).toBe(1)
  expect(await ledger.run(scope, "op-2", large, () => ++effects)).toBe(1)
})

test("retained JSON results are snapshots that cannot grow after byte accounting", async () => {
  const { ledger } = fixture({ maxBytes: 32 })
  const result = { value: "small" }
  const first = ledger.run(scope, "op-1", null, () => result)
  const retained = await first
  result.value = "x".repeat(100)
  expect(retained).toEqual({ value: "small" })
  expect(Object.isFrozen(retained)).toBe(true)
  expect(ledger.run(scope, "op-1", null, () => ({ value: "unexpected" }))).toBe(first)
  expect(await ledger.run(scope, "op-2", null, () => 1)).toBe(1)
})

test("oversized operation errors cannot escape the retained byte budget", async () => {
  const { ledger, at } = fixture({ maxBytes: 12 })
  let effects = 0
  const first = ledger.run(scope, "op-1", null, () => {
    effects++
    throw new RemoteReplyError("agent_busy", "x".repeat(100))
  })
  await expect(first).rejects.toMatchObject({ code: "limit_exceeded" })
  expect(ledger.run(scope, "op-1", null, () => ++effects)).toBe(first)
  expect(await ledger.run(scope, "op-2", null, () => 1)).toBe(1)
  at(1_100)
  expect(ledger.prune()).toBe(2)
  await expect(ledger.run(scope, "op-1", null, () => ++effects)).rejects.toMatchObject({
    code: "operation_expired",
  })
  expect(effects).toBe(1)
})

test("default limits admit image-sized payloads and retain results for the reconnect window", async () => {
  let time = 1_000
  const ledger = new OperationLedger({ now: () => time })
  const images = { images: ["a".repeat(Math.ceil((5 * 1024 * 1024 * 4) / 3))] }
  const first = ledger.run(scope, "op-1", images, () => "done")
  expect(await first).toBe("done")
  // Four image messages fit in 32 MiB; the fifth exceeds the default aggregate budget.
  for (const id of ["op-2", "op-3", "op-4"])
    expect(await ledger.run(scope, id, images, () => "done")).toBe("done")
  let effects = 0
  await expect(ledger.run(scope, "op-5", images, () => ++effects)).rejects.toMatchObject({
    code: "limit_exceeded",
  })
  expect(effects).toBe(0)
  time += 10 * 60 * 1_000 - 1
  expect(ledger.run(scope, "op-1", images, () => "unexpected")).toBe(first)
  time++
  await expect(ledger.run(scope, "op-1", images, () => "unexpected")).rejects.toMatchObject({
    code: "operation_expired",
  })
})

test("clock rollback cannot resurrect an expired id", async () => {
  const { ledger, at } = fixture()
  await ledger.run(scope, "op-1", payload, () => "done")
  at(1_100)
  ledger.prune()
  at(1_001)
  await expect(ledger.run(scope, "op-1", payload, () => "unexpected")).rejects.toMatchObject({
    code: "operation_expired",
  })
})

test("zero retention expires completed results but still coalesces running retries", async () => {
  const { ledger } = fixture({ retentionMs: 0 })
  const first = ledger.run(scope, "op-1", payload, () => "done")
  expect(ledger.run(scope, "op-1", payload, () => "unexpected")).toBe(first)
  await first
  await expect(ledger.run(scope, "op-1", payload, () => "unexpected")).rejects.toMatchObject({
    code: "operation_expired",
  })
})

test("bounded identity validation rejects malformed scopes and ids without consuming capacity", async () => {
  const { ledger } = fixture({ maxIds: 1 })
  for (const value of ["", "a".repeat(129), "bad identity", "line\nbreak"]) {
    for (const client of [
      { ...scope, clientId: value },
      { ...scope, controllerToken: value },
    ]) {
      await expect(ledger.run(client, "op-1", null, () => "unexpected")).rejects.toMatchObject({
        code: "invalid_frame",
      })
    }
    await expect(ledger.run(scope, value, null, () => "unexpected")).rejects.toMatchObject({
      code: "invalid_frame",
    })
  }
  expect(await ledger.run(scope, "op-1", null, () => "valid")).toBe("valid")
})

test("ledger configuration and clock values are validated", async () => {
  for (const key of ["maxEntries", "maxIds", "maxPayloadBytes", "maxBytes"] as const) {
    for (const value of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => fixture({ [key]: value })).toThrow(RangeError)
    }
  }
  for (const retentionMs of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => fixture({ retentionMs })).toThrow(RangeError)
  }
  const { ledger } = fixture({ now: () => -1 })
  await expect(ledger.run(scope, "op-1", null, () => "unexpected")).rejects.toThrow(RangeError)
})
