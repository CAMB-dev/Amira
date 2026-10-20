import "./offline.ts"
import { expect, test } from "bun:test"
import { ProxyGate } from "../../src/remote/proxy-gate.ts"
import { IdleDeadline } from "../../src/server/idle.ts"

test("idle fake clock requires a continuous quiet interval and resets on work or publication", () => {
  const timer = new IdleDeadline(1000)
  expect(timer.sample(0, { idle: true, revision: 0 })).toBe(false)
  expect(timer.sample(999, { idle: true, revision: 0 })).toBe(false)
  expect(timer.sample(1000, { idle: false, revision: 0 })).toBe(false)
  expect(timer.sample(9000, { idle: true, revision: 1 })).toBe(false)
  expect(timer.sample(9999, { idle: true, revision: 2 })).toBe(false)
  expect(timer.sample(10998, { idle: true, revision: 2 })).toBe(false)
  expect(timer.sample(10999, { idle: true, revision: 2 })).toBe(true)
  expect(new IdleDeadline(0).sample(1e12, { idle: true, revision: 0 })).toBe(false)
  for (const value of [-1, 0.5, Infinity, 2_147_483_648]) expect(() => new IdleDeadline(value)).toThrow()
})

test("zero disables proxy admission expiry without disabling cancellation or later attachment", async () => {
  const gate = new ProxyGate<string>(0)
  const abort = new AbortController()
  const pending = gate.wait(abort.signal)
  abort.abort()
  await expect(pending).rejects.toMatchObject({ code: "proxy_cancelled" })
  const resumed = gate.wait()
  gate.attach("broker")
  expect(await resumed).toBe("broker")
  gate.configure(20)
  gate.detach("broker")
  await expect(gate.wait()).rejects.toMatchObject({ code: "proxy_reconnect_expired" })
})
