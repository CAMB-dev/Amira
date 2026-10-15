import { expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import path from "node:path"
import { tryFileLock } from "../src/file-lock.ts"
import { takeFilesystemGate } from "../src/file-lock-gate.ts"
import { filesystemGatePath } from "./file-lock-fixtures.ts"
import {
  automaticCleanupLatency,
  inlineCleanupLatency,
  latencyWorkerReady,
} from "./file-lock-latency-timing.ts"
import { boundedExit, startGateReader } from "./file-lock-reader-fixture.ts"
import { waitForFileLockCondition } from "./file-lock-test-waits.ts"

const [dir] = process.argv.slice(2)
if (!dir || process.platform !== "win32") throw new Error("Windows temporary reader required")
const file = path.join(dir, "reader.lock")
const gate = filesystemGatePath(file)
const lease = tryFileLock(file, 1, undefined, true)!
expect(lease).toBeDefined()
const unlock = takeFilesystemGate(file)!
expect(unlock).toBeDefined()
const metadata = path.join(gate, "owner.json")
const contents = fs.readFileSync(metadata, "utf8")
const warnings: string[] = []
spyOn(process, "emitWarning").mockImplementation((message) => {
  warnings.push(String(message))
})
const waits = spyOn(Atomics, "wait")
const sleeps = spyOn(Bun, "sleepSync")
const inlineTiming = await inlineCleanupLatency("Windows reader", () => {
  const release = takeFilesystemGate(path.join(dir, "warm.lock"))!
  expect(release).toBeDefined()
  release()
})
const timing = await automaticCleanupLatency("Windows reader")
const rename = fs.renameSync
let attempts = 0
let yieldedAttempts = 0
let unyieldedRetries = 0
const pendingCallbacks = new Set<string>()
const ownerAttempts = new Map<string, number>()
const callbacks: Promise<void>[] = []
spyOn(fs, "renameSync").mockImplementation((...args) => {
  if (args[0] === gate && String(args[1]).includes(".retired-")) {
    const owner = String(args[1])
    ownerAttempts.set(owner, (ownerAttempts.get(owner) ?? 0) + 1)
    if (pendingCallbacks.has(owner)) unyieldedRetries++
    pendingCallbacks.add(owner)
    attempts++
    timing.noteAttempt()
    queueMicrotask(() => {
      pendingCallbacks.delete(owner)
      yieldedAttempts++
    })
    callbacks.push(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          resolve()
        }, 0),
      ),
    )
  }
  return rename(...args)
})
const { reader, go, stderr, waitUntilReady } = startGateReader(metadata, dir)
try {
  await waitUntilReady()
  await latencyWorkerReady(dir)
  inlineTiming.measure("release", () => lease.release())
  expect(fs.readFileSync(file, "utf8")).toContain(String(process.pid))
  const before = performance.now()
  const callback = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - before), 0))
  // Hold the reader until unlock has returned: scheduling cannot make contention
  // disappear while a synchronous retry loop is still on the calling thread.
  inlineTiming.measure("unlock", unlock)
  expect(attempts).toBe(1)
  expect(fs.readFileSync(metadata, "utf8")).toBe(contents)
  const elapsed = await callback
  console.log(`Windows reader: zero-delay callback ${elapsed.toFixed(2)}ms`)
  // Keep the actual deny-delete handle open through an automatic attempt.
  // It schedules another gate callback, and the pending lease cleanup has its
  // own timer: both must run even if a loaded scheduler outlasts the 100ms hold.
  await waitForFileLockCondition(
    "Windows reader: automatic cleanup while the handle is held",
    () => timing.attempts >= 2,
  )
  fs.writeFileSync(go, "go")
  expect(warnings).toEqual([])
  await boundedExit(reader, "reader")
  expect(reader.exitCode).toBe(0)
  expect(await stderr).toBe("")
  await waitForFileLockCondition(
    "Windows reader: automatic lease and gate cleanup after handle close",
    () => !fs.existsSync(file) && !fs.existsSync(gate),
  )
  await Promise.all(callbacks)
  await timing.waitForSamples()
  timing.assertResponsive()
  expect(unyieldedRetries).toBe(0)
  expect(yieldedAttempts).toBe(attempts)
  expect(attempts).toBeGreaterThan(1)
  // Each owner can be visited once inline, by five gate timers, and by ten
  // lease-cleanup timers. They share an attempt within a callback, not across
  // independent callbacks; their combined count depends on reader scheduling.
  for (const count of ownerAttempts.values()) expect(count).toBeLessThanOrEqual(1 + 5 + 10)
  expect(waits).not.toHaveBeenCalled()
  expect(sleeps).not.toHaveBeenCalled()
  expect(warnings).toEqual([])
  expect(fs.existsSync(file)).toBe(false)
  expect(fs.existsSync(gate)).toBe(false)
  const next = tryFileLock(file, 1, undefined, true)!
  expect(next).toBeDefined()
  next.release()
  expect(fs.readdirSync(dir).sort()).toEqual(["reader-go", "reader-ready"])
  inlineTiming.report()
} finally {
  if (reader.exitCode === null) reader.kill()
  await boundedExit(reader, "owned reader")
  lease.release()
}
