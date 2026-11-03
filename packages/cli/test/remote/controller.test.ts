import { expect, test } from "bun:test"
import { Controller, type ControllerOptions } from "../../src/server/controller.ts"

function fixture(options: ControllerOptions = {}) {
  let time = 1_000
  const controller = new Controller({
    graceMs: 100,
    tokenLifetimeMs: 1_000,
    now: () => time,
    ...options,
  })
  return { controller, at: (value: number) => (time = value) }
}

test("one controller holds the workspace and its token is opaque", () => {
  const { controller } = fixture()
  const lease = controller.attach({ clientId: "client-a" })
  expect(lease.clientId).toBe("client-a")
  expect(lease.controllerToken).toMatch(/^[a-f0-9]{64}$/)
  expect(lease.controllerGeneration).toBe(1)
  expect(() => controller.assertCurrent("client-a", 1)).not.toThrow()
  for (const request of [
    { clientId: "client-b" },
    { clientId: "client-a" },
    { clientId: "client-b", controllerToken: lease.controllerToken },
    { clientId: "client-a", controllerToken: "wrong-token" },
  ]) {
    expect(() => controller.attach(request)).toThrow(expect.objectContaining({ code: "controller_busy" }))
  }
})

test("a same-client token reconnect fences the live connection and its late detach", () => {
  const { controller } = fixture()
  const old = controller.attach({ clientId: "client-a" })
  const current = controller.attach(old)
  expect(current.controllerToken).toBe(old.controllerToken)
  expect(current.controllerGeneration).toBe(2)
  expect(() => controller.assertCurrent(old.clientId, old.controllerGeneration)).toThrow(
    expect.objectContaining({ code: "stale_controller" }),
  )
  expect(controller.detach(old.clientId, old.controllerGeneration)).toBe(false)
  expect(() => controller.assertCurrent(current.clientId, current.controllerGeneration)).not.toThrow()
  expect(() => controller.assertCurrent("client-b", current.controllerGeneration)).toThrow(
    expect.objectContaining({ code: "stale_controller" }),
  )
})

test("detaching reserves the token through grace and a reconnect increments generation", () => {
  const { controller, at } = fixture()
  const first = controller.attach({ clientId: "client-a" })
  expect(controller.detach(first.clientId, first.controllerGeneration)).toBe(true)
  expect(() => controller.assertCurrent(first.clientId, first.controllerGeneration)).toThrow(
    expect.objectContaining({ code: "stale_controller" }),
  )
  at(1_099)
  expect(() => controller.attach({ clientId: "client-b" })).toThrow(
    expect.objectContaining({ code: "controller_busy" }),
  )
  const reconnected = controller.attach(first)
  expect(reconnected.controllerGeneration).toBe(2)
  expect(reconnected.controllerToken).toBe(first.controllerToken)
})

test("duplicate detach cannot extend grace and a fresh client wins exactly at expiry", () => {
  const { controller, at } = fixture()
  const first = controller.attach({ clientId: "client-a" })
  controller.detach(first.clientId, first.controllerGeneration)
  at(1_099)
  expect(controller.detach(first.clientId, first.controllerGeneration)).toBe(false)
  at(1_100)
  expect(() => controller.attach(first)).toThrow(expect.objectContaining({ code: "permission_denied" }))
  const next = controller.attach({ clientId: "client-b" })
  expect(next.controllerGeneration).toBe(2)
  expect(next.controllerToken).not.toBe(first.controllerToken)
  expect(controller.detach(first.clientId, first.controllerGeneration)).toBe(false)
})

test("old credentials cannot reacquire a vacant workspace, even with the same client id", () => {
  const { controller, at } = fixture()
  const first = controller.attach({ clientId: "client-a" })
  controller.detach(first.clientId, first.controllerGeneration)
  at(1_100)
  const next = controller.attach({ clientId: first.clientId })
  expect(next.controllerToken).not.toBe(first.controllerToken)
  expect(() => controller.attach(first)).toThrow(expect.objectContaining({ code: "controller_busy" }))
})

test("zero grace releases a detached lease immediately, never a live one", () => {
  const { controller, at } = fixture({ graceMs: 0 })
  const first = controller.attach({ clientId: "client-a" })
  at(1_500)
  expect(() => controller.attach({ clientId: "client-b" })).toThrow(
    expect.objectContaining({ code: "controller_busy" }),
  )
  controller.detach(first.clientId, first.controllerGeneration)
  expect(controller.attach({ clientId: "client-b" }).controllerGeneration).toBe(2)
})

test("token age is absolute, not renewed by reconnect, and cannot permit a live takeover", () => {
  const { controller, at } = fixture({ graceMs: 1_000, tokenLifetimeMs: 100 })
  const first = controller.attach({ clientId: "client-a" })
  at(1_099)
  const current = controller.attach(first)
  at(1_100)
  expect(() => controller.attach(current)).toThrow(expect.objectContaining({ code: "permission_denied" }))
  expect(() => controller.attach({ clientId: "client-b" })).toThrow(
    expect.objectContaining({ code: "controller_busy" }),
  )
  // Existing transport authority survives token expiry, but cannot be transferred by that token.
  expect(() => controller.assertCurrent(current.clientId, current.controllerGeneration)).not.toThrow()
  controller.detach(current.clientId, current.controllerGeneration)
  expect(controller.attach({ clientId: "client-b" }).controllerGeneration).toBe(3)
})

test("a detached identity is discarded at the earlier of token age and grace", () => {
  const { controller, at } = fixture({ tokenLifetimeMs: 50 })
  const first = controller.attach({ clientId: "client-a" })
  at(1_040)
  controller.detach(first.clientId, first.controllerGeneration)
  at(1_050)
  expect(() => controller.attach(first)).toThrow(expect.objectContaining({ code: "permission_denied" }))
  expect(controller.attach({ clientId: "client-b" }).controllerGeneration).toBe(2)
})

test("clock rollback never extends a token's lifetime", () => {
  const { controller, at } = fixture({ tokenLifetimeMs: 100 })
  const first = controller.attach({ clientId: "client-a" })
  at(1_100)
  expect(() => controller.attach(first)).toThrow(expect.objectContaining({ code: "permission_denied" }))
  at(1_001)
  expect(() => controller.attach(first)).toThrow(expect.objectContaining({ code: "permission_denied" }))
})

test("returned leases are immutable and cannot mutate controller authority", () => {
  const { controller } = fixture()
  const lease = controller.attach({ clientId: "client-a" })
  expect(Object.isFrozen(lease)).toBe(true)
  expect(Reflect.set(lease, "clientId", "client-b")).toBe(false)
  expect(() => controller.assertCurrent("client-a", lease.controllerGeneration)).not.toThrow()
})

test("invalid identity, token and generation inputs do not change a lease", () => {
  const { controller } = fixture()
  for (const clientId of ["", "a".repeat(129), "line\nbreak", "space here", "é"]) {
    expect(() => controller.attach({ clientId })).toThrow(expect.objectContaining({ code: "invalid_frame" }))
  }
  for (const controllerToken of ["", "a".repeat(129), "bad token"]) {
    expect(() => controller.attach({ clientId: "client-a", controllerToken })).toThrow(
      expect.objectContaining({ code: "invalid_frame" }),
    )
  }
  const lease = controller.attach({ clientId: "client-a" })
  for (const generation of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => controller.assertCurrent(lease.clientId, generation)).toThrow(
      expect.objectContaining({ code: "invalid_frame" }),
    )
    expect(() => controller.detach(lease.clientId, generation)).toThrow(
      expect.objectContaining({ code: "invalid_frame" }),
    )
  }
  expect(() => controller.assertCurrent(lease.clientId, lease.controllerGeneration)).not.toThrow()
})

test("unknown resume tokens fail closed rather than creating a lease", () => {
  const { controller } = fixture()
  expect(() => controller.attach({ clientId: "client-a", controllerToken: "unknown" })).toThrow(
    expect.objectContaining({ code: "permission_denied" }),
  )
  expect(controller.attach({ clientId: "client-a" }).controllerGeneration).toBe(1)
})

test("controller configuration and clock values are bounded", () => {
  for (const graceMs of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => fixture({ graceMs })).toThrow(RangeError)
  }
  for (const tokenLifetimeMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => fixture({ tokenLifetimeMs })).toThrow(RangeError)
  }
  const { controller } = fixture({ now: () => -1 })
  expect(() => controller.attach({ clientId: "client-a" })).toThrow(RangeError)
})

test("holds reports the lease holder while attached and through grace only", () => {
  const { controller, at } = fixture()
  expect(controller.holds("client-a")).toBe(false)
  const lease = controller.attach({ clientId: "client-a" })
  expect(controller.holds("client-a")).toBe(true)
  expect(controller.holds("client-b")).toBe(false)
  controller.detach(lease.clientId, lease.controllerGeneration)
  at(1_099)
  expect(controller.holds("client-a")).toBe(true)
  at(1_100)
  expect(controller.holds("client-a")).toBe(false)
})

test("take of a free workspace is a fresh lease; a roles-aware holder is taken over after one second", () => {
  const { controller, at } = fixture()
  const first = controller.take({ clientId: "client-a" })
  expect(first.previous).toBeUndefined()
  expect(first.lease.controllerGeneration).toBe(1)
  at(1_999)
  expect(() => controller.take({ clientId: "client-b" })).toThrow(
    expect.objectContaining({ code: "controller_busy" }),
  )
  at(2_000)
  const second = controller.take({ clientId: "client-b" })
  expect(second.previous).toEqual({ lease: first.lease, attached: true })
  expect(second.lease.controllerGeneration).toBe(2)
  expect(second.lease.controllerToken).not.toBe(first.lease.controllerToken)
  expect(() => controller.assertCurrent("client-a", 1)).toThrow(
    expect.objectContaining({ code: "stale_controller" }),
  )
  // The fenced holder's late close cannot open a grace window.
  expect(controller.detach("client-a", 1)).toBe(false)
  expect(controller.state()).toEqual({ state: "attached" })
  // The later click loses: the holder just changed.
  expect(() => controller.take({ clientId: "client-a" })).toThrow(
    expect.objectContaining({ code: "controller_busy" }),
  )
})

test("an attached legacy holder is never taken over; its grace can be", () => {
  const { controller, at } = fixture({ tokenLifetimeMs: 100_000 })
  const legacy = controller.attach({ clientId: "client-a" })
  at(5_000)
  expect(() => controller.take({ clientId: "client-b" })).toThrow(
    expect.objectContaining({ code: "controller_busy" }),
  )
  controller.detach(legacy.clientId, legacy.controllerGeneration)
  expect(controller.state()).toEqual({ state: "detached", graceRemainingMs: 100 })
  at(5_040)
  expect(controller.state()).toEqual({ state: "detached", graceRemainingMs: 60 })
  const taken = controller.take({ clientId: "client-b" })
  expect(taken.previous).toEqual({ lease: legacy, attached: false })
  // Grace ended with the take: the old token cannot resume.
  expect(() => controller.attach(legacy)).toThrow(expect.objectContaining({ code: "controller_busy" }))
})

test("a roles reconnect records its flags; a non-serving taker cannot strand a model-serving holder", () => {
  const { controller, at } = fixture({ tokenLifetimeMs: 100_000 })
  const legacy = controller.attach({ clientId: "client-a" })
  const roles = controller.attach({ ...legacy, roles: true, servesModels: true })
  at(5_000)
  expect(() => controller.take({ clientId: "client-b" })).toThrow(
    expect.objectContaining({ code: "unsupported_capability" }),
  )
  expect(() => controller.take({ clientId: "client-b", servesModels: false })).toThrow(
    expect.objectContaining({ code: "unsupported_capability" }),
  )
  const taken = controller.take({ clientId: "client-b", servesModels: true })
  expect(taken.previous?.lease).toBe(roles)
  at(6_000)
  // In grace the holder serves nothing, so any taker may take it.
  controller.detach(taken.lease.clientId, taken.lease.controllerGeneration)
  at(6_050)
  expect(controller.take({ clientId: "client-c" }).previous?.attached).toBe(false)
})

test("taking an own lease reissues it at once, covering a lost welcome", () => {
  const { controller, at } = fixture()
  const first = controller.take({ clientId: "client-a" })
  const again = controller.take({ clientId: "client-a" })
  expect(again.previous).toEqual({ lease: first.lease, attached: true })
  expect(again.lease.controllerGeneration).toBe(2)
  expect(again.lease.controllerToken).not.toBe(first.lease.controllerToken)
  controller.detach(again.lease.clientId, again.lease.controllerGeneration)
  const third = controller.take({ clientId: "client-a" })
  expect(third.previous?.attached).toBe(false)
  // The own retake kept the original acquisition time for the one-second rule.
  at(2_000)
  expect(controller.take({ clientId: "client-b" }).previous?.lease).toBe(third.lease)
})

test("a take mints a full token lifetime, unlike a resume", () => {
  const { controller, at } = fixture({ tokenLifetimeMs: 100 })
  const first = controller.attach({ clientId: "client-a" })
  at(1_090)
  const taken = controller.take({ clientId: "client-a" })
  at(1_150)
  expect(() => controller.attach(first)).toThrow(expect.objectContaining({ code: "controller_busy" }))
  expect(controller.attach(taken.lease).controllerGeneration).toBe(3)
  at(1_190)
  expect(() => controller.attach(taken.lease)).toThrow(expect.objectContaining({ code: "permission_denied" }))
})

test("release by the holder's own token ends the lease without grace", () => {
  const { controller } = fixture()
  const lease = controller.attach({ clientId: "client-a", roles: true })
  expect(controller.release({ clientId: "client-b", controllerToken: lease.controllerToken })).toBeUndefined()
  expect(controller.release({ clientId: "client-a", controllerToken: "other-token" })).toBeUndefined()
  expect(controller.release(lease)).toBe(lease)
  expect(controller.holds("client-a")).toBe(false)
  expect(controller.state()).toEqual({ state: "none" })
  expect(() => controller.assertCurrent(lease.clientId, lease.controllerGeneration)).toThrow(
    expect.objectContaining({ code: "stale_controller" }),
  )
  expect(controller.release(lease)).toBeUndefined()
  // Released in grace too; nobody waits out the reservation.
  const next = controller.attach({ clientId: "client-b" })
  controller.detach(next.clientId, next.controllerGeneration)
  expect(controller.release(next)).toBe(next)
  expect(controller.attach({ clientId: "client-c" }).controllerGeneration).toBe(3)
  // An expired token releases nothing.
  const { controller: aged, at: age } = fixture({ tokenLifetimeMs: 50 })
  const old = aged.attach({ clientId: "client-a" })
  age(1_050)
  expect(aged.release(old)).toBeUndefined()
  expect(aged.holds("client-a")).toBe(true)
})

test("take and release validate their inputs", () => {
  const { controller } = fixture()
  expect(() => controller.take({ clientId: "bad id" })).toThrow(
    expect.objectContaining({ code: "invalid_frame" }),
  )
  expect(() => controller.release({ clientId: "client-a", controllerToken: "" })).toThrow(
    expect.objectContaining({ code: "invalid_frame" }),
  )
  expect(controller.state()).toEqual({ state: "none" })
})
