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
