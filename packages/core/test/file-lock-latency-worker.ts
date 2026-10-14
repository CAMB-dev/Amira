import { expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import path from "node:path"
import { tryFileLock } from "../src/file-lock.ts"
import { takeFilesystemGate } from "../src/file-lock-gate.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"
import { automaticCleanupLatency, inlineCleanupLatency } from "./file-lock-latency-timing.ts"

const [dir, mode] = process.argv.slice(2)
if (!dir || !mode) throw new Error("missing latency worker arguments")
// Warm the real publication path before timing; startup/module and cold-cache costs
// are not the cleanup retry regression. The measured claim still publishes a fresh lease.
const warm = SessionStore.create({ cwd: dir, dir })
expect(warm.claim()).toBe(true)
warm.release()
const inlineTiming = await inlineCleanupLatency(mode, () => {
  expect(warm.claim()).toBe(true)
  warm.release()
})
const timing = await automaticCleanupLatency(mode)
const store = SessionStore.create({ cwd: dir, dir })
const file = sessionLockFile(store.file)
const gate = `${file}.lease-gate`
const warnings: string[] = []
spyOn(process, "emitWarning").mockImplementation((message) => {
  warnings.push(String(message))
})
const waits = spyOn(Atomics, "wait")
const sleeps = spyOn(Bun, "sleepSync")
const rename = fs.renameSync
const rm = fs.rmSync
let armed = false
let privateBlocked = false
let blocked = true
let attempts = 0
let privateAttempts = 0
let inline = false
let yieldedAttempts = 0
let unyieldedRetries = 0
const pendingCallbacks = new Set<string>()
const callbacks: Promise<number>[] = []
spyOn(fs, "renameSync").mockImplementation((...args) => {
  if (armed && args[0] === gate && String(args[1]).includes(".retired-")) {
    // Automatic retries must leave the preceding callback. A microtask sentinel
    // permits independent cleanup timers in the same timers phase, but not a spin
    // inside one callback. This reader cannot expire during a synchronous spin.
    const owner = String(args[1])
    if (!inline && pendingCallbacks.has(owner)) unyieldedRetries++
    pendingCallbacks.add(owner)
    attempts++
    timing.noteAttempt()
    queueMicrotask(() => {
      pendingCallbacks.delete(owner)
      yieldedAttempts++
    })
    const before = performance.now()
    callbacks.push(
      new Promise<number>((resolve) => {
        setTimeout(() => {
          resolve(performance.now() - before)
        }, 0)
      }),
    )
    if (attempts === 1)
      setTimeout(() => {
        blocked = false
      }, 100)
    // Require repeated automatic samples even if a loaded scheduler runs the
    // reader-release timer before the next retry. Keep the real 100ms hold too.
    if (blocked || timing.attempts < 3)
      throw Object.assign(new Error("100ms deny-delete reader"), { code: "EBUSY" })
  }
  return rename(...args)
})
spyOn(fs, "rmSync").mockImplementation((...args) => {
  if (privateBlocked && String(args[0]).startsWith(`${file}.pending-`)) {
    privateAttempts++
    throw Object.assign(new Error("private publication reader"), { code: "EACCES" })
  }
  return rm(...args)
})
function boundedAttempt(entry: string, action: () => void) {
  const before = attempts
  inline = true
  try {
    inlineTiming.measure(entry, action)
  } finally {
    inline = false
  }
  // One exact-owned attempt per synchronous operation, even while the reader is held.
  expect(attempts - before).toBe(1)
}
async function latency(action: () => void) {
  const before = performance.now()
  const callback = new Promise<number>((resolve) => {
    setTimeout(() => resolve(performance.now() - before), 0)
  })
  action()
  expect(blocked).toBe(true)
  const elapsed = await callback
  console.log(`${mode}: zero-delay callback ${elapsed.toFixed(2)}ms; gate attempts ${attempts}`)
}
if (mode === "claim") {
  armed = true
  await latency(() => boundedAttempt("claim", () => expect(store.claim()).toBe(true)))
} else {
  privateBlocked = mode === "reclaim"
  expect(store.claim()).toBe(true)
  armed = true
  if (mode === "release") await latency(() => boundedAttempt("release", () => store.release()))
  else {
    const unlock = takeFilesystemGate(file)!
    expect(unlock).toBeDefined()
    let before = 0
    let privateBefore = 0
    let acquired: ReturnType<typeof tryFileLock>
    await latency(() => {
      boundedAttempt("unlock", unlock)
      boundedAttempt("release", () => store.release())
      before = attempts
      privateBefore = privateAttempts
      boundedAttempt("reclaim", () => {
        acquired = tryFileLock(file, 1, undefined, true)
      })
    })
    expect(acquired).toBeUndefined()
    // Pending lease cleanup and acquisition consult the same owned gate once, not twice.
    expect(attempts - before).toBe(1)
    expect(privateAttempts - privateBefore).toBe(1)
    privateBlocked = false
  }
}
// Exercise the automatic chains too: no synchronous wait is allowed in timer callbacks.
await Bun.sleep(350)
await timing.waitForSamples()
const callbackDelays = await Promise.all(callbacks)
console.log(`${mode}: inline/automatic callback maximum ${Math.max(...callbackDelays).toFixed(2)}ms`)
timing.assertResponsive()
expect(yieldedAttempts).toBe(attempts)
expect(unyieldedRetries).toBe(0)
expect(blocked).toBe(false)
expect(waits).not.toHaveBeenCalled()
expect(sleeps).not.toHaveBeenCalled()
expect(attempts).toBeGreaterThan(1)
expect(attempts).toBeLessThanOrEqual(8)
expect(warnings).toEqual([])
store.release()
await Bun.sleep(150)
expect(fs.existsSync(file)).toBe(false)
expect(fs.existsSync(gate)).toBe(false)
expect(store.claim()).toBe(true)
store.appendDisplay({ type: "display", level: "info", text: "safe after reader" })
store.release()
expect(SessionStore.open(store.file).entries.some((entry) => entry.type === "display")).toBe(true)
expect(fs.readdirSync(dir)).toEqual([path.basename(store.file)])
expect(warnings).toEqual([])
inlineTiming.report()
