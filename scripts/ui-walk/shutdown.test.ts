import { expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createShutdown } from "./shutdown.ts"

const busy = () => Object.assign(new Error("EBUSY: temporary file lock"), { code: "EBUSY" })

test("shutdown stops servers despite a held file lock, then retries after release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-walk-shutdown-"))
  await writeFile(path.join(root, "locked.txt"), "fixture")
  let locked = true
  let resourcesStopped = 0
  let serversStopped = 0
  const shutdown = createShutdown({
    async stopResources() {
      resourcesStopped++
    },
    async removeFiles() {
      if (locked) throw busy()
      await rm(root, { recursive: true, force: true })
    },
    stopServer() {
      serversStopped++
    },
    retryMs: 10,
    retryWindowMs: 100,
  })
  try {
    await expect(shutdown.close(true)).rejects.toThrow("EBUSY")
    expect(serversStopped).toBeGreaterThan(0)
    expect(resourcesStopped).toBe(1)
    locked = false
    await shutdown.close(true)
    expect(await stat(root).catch(() => undefined)).toBeUndefined()
    expect(resourcesStopped).toBe(1)
  } finally {
    locked = false
    await shutdown.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test("persistent locks exhaust a bounded retry window rather than retaining a live server", async () => {
  let expired!: () => void
  const expiration = new Promise<void>((resolve) => {
    expired = resolve
  })
  let attempts = 0
  let serversStopped = 0
  const shutdown = createShutdown({
    async stopResources() {},
    async removeFiles() {
      attempts++
      throw busy()
    },
    stopServer() {
      serversStopped++
    },
    exhausted(error) {
      expect(String(error)).toContain("EBUSY")
      expired()
    },
    retryMs: 10,
    retryWindowMs: 60,
  })
  await expect(shutdown.close()).rejects.toThrow("EBUSY")
  expect(serversStopped).toBeGreaterThan(0)
  await expiration
  expect(attempts).toBeGreaterThan(1)
  const finalAttempts = attempts
  await Bun.sleep(30)
  expect(attempts).toBe(finalAttempts)
}, 1000)
