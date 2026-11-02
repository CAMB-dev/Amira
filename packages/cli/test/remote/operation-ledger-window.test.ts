import { expect, test } from "bun:test"
import { OperationLedger, type OperationLedgerOptions } from "../../src/server/operation-ledger.ts"

const payload = { op: "turn.prompt", params: { message: "hello" } }
const scope = (clientId: string) => ({ clientId, controllerToken: "epoch-1" })

function fixture(options: OperationLedgerOptions = {}) {
  let time = 1_000
  const ledger = new OperationLedger({
    retentionMs: 100,
    maxEntries: 4,
    windowIds: 4,
    maxIds: 8,
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

/** Private counters, read only to prove the bounds hold. */
function sizes(ledger: OperationLedger) {
  const inner = ledger as unknown as {
    scopes: Map<string, { window: Map<string, unknown> }>
    forgottenScopes: Set<string>
    settled: Set<unknown>
    live: number
    ids: number
    bytes: number
  }
  const windows = [...inner.scopes.values()].map((state) => state.window.size)
  return {
    live: inner.live,
    ids: inner.ids,
    bytes: inner.bytes,
    windows,
    scopes: inner.scopes.size,
    forgotten: inner.forgottenScopes.size,
    counted: windows.reduce((sum, size) => sum + size, 0),
  }
}

test("past the global id cap the least recently active idle scope is forgotten and refused", async () => {
  const inUse = new Set<string>()
  const { ledger } = fixture({ maxIds: 3, inUse: (clientId) => inUse.has(clientId) })
  let effects = 0
  await ledger.run(scope("old"), "op-1", payload, () => ++effects)
  await ledger.run(scope("held"), "op-1", payload, () => ++effects)
  await ledger.run(scope("busy"), "op-1", payload, () => ++effects)
  inUse.add("held")
  // "old" is the least recently active scope that is neither in use nor running.
  expect(await ledger.run(scope("busy"), "op-2", payload, () => ++effects)).toBe(4)
  expect(ledger.isForgotten(scope("old"))).toBe(true)
  expect(ledger.isForgotten(scope("held"))).toBe(false)
  for (const id of ["op-1", "op-9"])
    await expect(ledger.run(scope("old"), id, payload, () => ++effects)).rejects.toMatchObject({
      code: "permission_denied",
    })
  // The forgotten scope's epoch-qualified identity only: another epoch is a new scope.
  expect(ledger.isForgotten({ clientId: "old", controllerToken: "epoch-2" })).toBe(false)
  await expect(ledger.run(scope("held"), "op-1", payload, () => ++effects)).resolves.toBe(2)
  expect(effects).toBe(4)
})

test("scopes that are in use or running are never forgotten; then admission fails without running", async () => {
  const pending = deferred<string>()
  const { ledger } = fixture({ maxIds: 2, inUse: (clientId) => clientId === "held" })
  let effects = 0
  await ledger.run(scope("held"), "op-1", payload, () => ++effects)
  const running = ledger.run(scope("running"), "op-1", payload, () => {
    effects++
    return pending.promise
  })
  await expect(ledger.run(scope("new"), "op-1", payload, () => ++effects)).rejects.toMatchObject({
    code: "limit_exceeded",
  })
  expect(effects).toBe(2)
  expect(ledger.isForgotten(scope("new"))).toBe(false)
  pending.resolve("done")
  expect(await running).toBe("done")
  // Settled, not in use: "running" can now be forgotten for the new scope.
  expect(await ledger.run(scope("new"), "op-1", payload, () => ++effects)).toBe(3)
  expect(ledger.isForgotten(scope("running"))).toBe(true)
})

test("an idle scope is forgotten after idleScopeMs unless in use; settlement counts as activity", async () => {
  let held = true
  const { ledger, at } = fixture({ idleScopeMs: 1_000, inUse: (clientId) => held && clientId === "held" })
  let effects = 0
  await ledger.run(scope("idle"), "op-1", payload, () => ++effects)
  await ledger.run(scope("held"), "op-1", payload, () => ++effects)
  const pending = deferred<string>()
  const late = ledger.run(scope("late"), "op-1", payload, () => pending.promise)
  at(1_999)
  expect(ledger.isForgotten(scope("idle"))).toBe(false)
  pending.resolve("done")
  await late
  at(2_000)
  expect(ledger.isForgotten(scope("idle"))).toBe(true)
  expect(ledger.isForgotten(scope("held"))).toBe(false)
  // "late" settled at 1,999 and stays remembered until 2,999: its tombstone still refuses reruns.
  at(2_100)
  await expect(ledger.run(scope("late"), "op-1", payload, () => ++effects)).rejects.toMatchObject({
    code: "operation_expired",
  })
  held = false
  at(2_998)
  expect(ledger.isForgotten(scope("held"))).toBe(true)
  expect(ledger.isForgotten(scope("late"))).toBe(false)
  at(2_999)
  expect(ledger.isForgotten(scope("late"))).toBe(true)
  expect(effects).toBe(2)
})

test("the forgotten set is bounded and drops its oldest scope first", async () => {
  const { ledger, at } = fixture({ idleScopeMs: 10, maxForgotten: 2 })
  for (const client of ["a", "b", "c"]) await ledger.run(scope(client), "op-1", payload, () => 1)
  at(2_000)
  ledger.prune()
  expect(sizes(ledger).forgotten).toBe(2)
  expect(ledger.isForgotten(scope("a"))).toBe(false)
  expect(ledger.isForgotten(scope("b"))).toBe(true)
  expect(ledger.isForgotten(scope("c"))).toBe(true)
})

/** One client's view of its own admissions, as the client contract lets it reason about them. */
interface ModelScope {
  clientId: string
  /** Ids whose executor ran, oldest first, since the scope was created, forgotten or revived. */
  admitted: string[]
  payloads: Map<string, string>
  promises: Map<string, Promise<unknown>>
  /** Executors this test has not resolved yet: the ledger still counts them as running. */
  unresolved: number
  forgottenAt?: number
}

test("randomized runs never re-execute an id inside the client window, refuse forgotten clients and keep every cap", async () => {
  const totals = { inWindow: 0, conflicts: 0, refusedForgotten: 0, dropped: 0, reruns: 0 }
  for (let seed = 1; seed <= 60; seed++) {
    let state = seed
    const random = (limit: number) => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
      return state % limit
    }
    let time = 0
    const options = {
      retentionMs: 50,
      maxEntries: 6,
      windowIds: 5,
      maxIds: 14,
      idleScopeMs: 400,
      maxForgotten: 3,
      maxBytes: 400,
    }
    const held = new Set<string>()
    const ledger = new OperationLedger({ ...options, now: () => time, inUse: (id) => held.has(id) })
    const violations: string[] = []
    const fail = (message: string) => violations.push(`seed ${seed}: ${message}`)
    const all: ModelScope[] = []
    const fresh = (slot: number) => {
      const model: ModelScope = {
        clientId: `c${slot}-${all.length}`,
        admitted: [],
        payloads: new Map(),
        promises: new Map(),
        unresolved: 0,
      }
      all.push(model)
      return model
    }
    const active = [0, 1, 2, 3, 4].map(fresh)
    const retired: ModelScope[] = []
    const forgottenSteps: number[] = []
    const pending: { model: ModelScope; resolve: (value: string) => void }[] = []
    const checks: Promise<unknown>[] = []
    let nextId = 0

    /** Observe forgetting through the public API and check it against the documented rules. */
    const observe = (
      model: ModelScope,
      step: number,
      heldThroughStep: boolean,
      now = ledger.isForgotten(scope(model.clientId)),
    ) => {
      if (now && model.forgottenAt === undefined) {
        if (model.unresolved) fail(`${model.clientId} forgotten while running`)
        if (heldThroughStep) fail(`${model.clientId} forgotten while in use`)
        model.forgottenAt = step
        forgottenSteps.push(step)
        model.admitted = []
      } else if (!now && model.forgottenAt !== undefined) {
        const since = forgottenSteps.filter((at) => at >= model.forgottenAt!).length - 1
        if (since < options.maxForgotten) fail(`${model.clientId} dropped from the forgotten set too early`)
        model.forgottenAt = undefined
        totals.dropped++
      } else if (now) {
        const later = forgottenSteps.filter((at) => at > model.forgottenAt!).length
        if (later >= options.maxForgotten) fail(`${model.clientId} kept past the forgotten-set cap`)
      }
    }

    /** One call. A resend with fewer than windowIds newer admitted ids must not run again. */
    const send = (model: ModelScope, id: string, body: string, first: boolean) => {
      const refusedAsForgotten = model.forgottenAt !== undefined
      const position = model.admitted.lastIndexOf(id)
      const newer = position < 0 ? Infinity : model.admitted.length - 1 - position
      const protectedResend = !first && !refusedAsForgotten && newer < options.windowIds
      const conflicting = protectedResend && model.payloads.get(id) !== body
      let ran = false
      const call = ledger.run(scope(model.clientId), id, { id, body }, () => {
        ran = true
        if (random(3) === 0) return "x".repeat(random(200))
        model.unresolved++
        return new Promise<string>((resolve) => pending.push({ model, resolve }))
      })
      if (protectedResend) totals.inWindow++
      if (conflicting) totals.conflicts++
      if (refusedAsForgotten) totals.refusedForgotten++
      if (ran) {
        if (protectedResend) fail(`${model.clientId}/${id} ran again with ${newer} newer ids`)
        if (refusedAsForgotten) fail(`${model.clientId}/${id} ran for a forgotten client`)
        if (!first) totals.reruns++
        model.admitted.push(id)
        model.payloads.set(id, body)
        model.promises.set(id, call)
      } else if (!refusedAsForgotten && model.payloads.get(id) === body && call === model.promises.get(id)) {
        // A retained resend with the same payload shares the original outcome.
        return
      }
      checks.push(
        call.then(
          () => {
            if (!ran) fail(`${model.clientId}/${id} resolved without running or sharing the original`)
          },
          (error: { code?: string }) => {
            if (ran) return
            const allowed = refusedAsForgotten
              ? ["permission_denied"]
              : protectedResend
                ? conflicting
                  ? ["operation_conflict", "operation_expired"]
                  : ["operation_expired"]
                : first
                  ? ["limit_exceeded"]
                  : ["limit_exceeded", "operation_expired", "operation_conflict"]
            if (!allowed.includes(error.code ?? ""))
              fail(`${model.clientId}/${id} refused with ${error.code}, expected ${allowed.join(" or ")}`)
          },
        ),
      )
    }

    for (let step = 0; step < 800; step++) {
      const slot = random(active.length)
      const model = active[slot]!
      const heldBefore = new Set(held)
      observe(model, step, false)
      const action = random(12)
      if (model.forgottenAt !== undefined) {
        // A refused client starts over with a new clientId; the old one only probes now and then.
        send(model, `op-${nextId++}`, "", true)
        retired.push(model)
        active[slot] = fresh(slot)
      } else if (action < 4 || !model.admitted.length) {
        send(model, `op-${nextId++}`, "x".repeat(random(60)), true)
      } else if (action < 7) {
        const id = model.admitted[random(model.admitted.length)]!
        send(model, id, random(4) === 0 ? "changed" : model.payloads.get(id)!, false)
      } else if (action < 8 && retired.length) {
        const old = retired[random(retired.length)]!
        observe(old, step, false)
        const ids = [...old.payloads.keys()]
        if (ids.length) {
          const id = ids[random(ids.length)]!
          send(old, id, old.payloads.get(id)!, false)
        }
      } else if (action < 10) {
        const [settled] = pending.splice(random(pending.length + 1), 1)
        if (settled) {
          settled.model.unresolved--
          settled.resolve("done")
        }
      } else time += random(120)
      if (random(20) === 0) held.has(model.clientId) ? held.delete(model.clientId) : held.add(model.clientId)
      await Promise.resolve()
      // Record this step's new forgettings before judging which older ones were dropped.
      const seen = all.map((each) => [each, ledger.isForgotten(scope(each.clientId))] as const)
      for (const [each, now] of [...seen].sort(([, a], [, b]) => Number(b) - Number(a)))
        observe(each, step, heldBefore.has(each.clientId) && held.has(each.clientId), now)
      const now = sizes(ledger)
      if (now.live > options.maxEntries) fail(`live ${now.live}`)
      if (now.bytes > options.maxBytes) fail(`bytes ${now.bytes}`)
      if (now.ids !== now.counted || now.ids > options.maxIds) fail(`ids ${now.ids}/${now.counted}`)
      if (now.forgotten > options.maxForgotten) fail(`forgotten ${now.forgotten}`)
      for (const size of now.windows)
        if (size > options.windowIds + options.maxEntries) fail(`window ${size}`)
    }
    for (const { model, resolve } of pending) {
      model.unresolved--
      resolve("done")
    }
    await Promise.all(checks)
    expect(violations).toEqual([])
  }
  // Every guarded path ran, not only first admissions.
  for (const count of Object.values(totals)) expect(count).toBeGreaterThan(20)
})

/** Retained heap growth of one ledger after a workload, measured rather than estimated. */
async function retainedBytes(work: (ledger: OperationLedger) => Promise<void>) {
  Bun.gc(true)
  const before = process.memoryUsage().heapUsed
  const ledger = new OperationLedger()
  await work(ledger)
  Bun.gc(true)
  return { ledger, bytes: process.memoryUsage().heapUsed - before }
}

test("memory stays bounded for a million sequential ids and for many one-id clients", async () => {
  const sequential = await retainedBytes(async (ledger) => {
    for (let index = 0; index < 1_000_000; index++)
      await ledger.run(scope("long-lived"), `op-${index}`, null, () => 1)
  })
  expect(sizes(sequential.ledger)).toMatchObject({ live: 128, ids: 4_096, scopes: 1, forgotten: 0 })
  expect(sequential.bytes).toBeLessThan(8 * 1024 * 1024)
  const clients = await retainedBytes(async (ledger) => {
    for (let index = 0; index < 100_000; index++)
      await ledger.run(scope(`client-${index}`), "op-1", null, () => 1)
  })
  const after = sizes(clients.ledger)
  expect(after.ids).toBe(65_536)
  expect(after.scopes).toBe(after.ids)
  expect(after.forgotten).toBe(100_000 - after.scopes)
  expect(clients.bytes).toBeLessThan(96 * 1024 * 1024)
}, 120_000)
