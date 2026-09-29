import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { LockBusyError, tryFileLock, waitFileLock } from "../src/file-lock.ts"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-file-lock-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("a lock is exclusive, records its holder and is released", () => {
  const file = path.join(dir, "x.lock")
  const a = tryFileLock(file, 60_000)!
  expect(readFileSync(file, "utf8").trim()).toBe(String(process.pid))
  expect(tryFileLock(file, 60_000)).toBeUndefined()
  a.release()
  expect(existsSync(file)).toBe(false)
  tryFileLock(file, 60_000)!.release()
})

test("a dead holder's lock or one not touched for staleMs is taken over; a live fresh one is not", () => {
  const file = path.join(dir, "x.lock")
  writeFileSync(file, "999999999\n")
  const a = tryFileLock(file, 60_000)
  expect(a).toBeDefined()
  a!.release()
  // A live holder (this process) whose lock is old: stale by age.
  writeFileSync(file, `${process.pid}\n`)
  expect(tryFileLock(file, 60_000)).toBeUndefined()
  utimesSync(file, new Date(0), new Date(0))
  const b = tryFileLock(file, 60_000)
  expect(b).toBeDefined()
  b!.release()
  // No stale-lock leftovers.
  expect(require("node:fs").readdirSync(dir)).toEqual([])
})

test("a holder's heartbeat keeps its lock fresh; waiting gives up after waitMs", async () => {
  const file = path.join(dir, "x.lock")
  const held = tryFileLock(file, 60_000, 20)!
  utimesSync(file, new Date(0), new Date(0))
  await Bun.sleep(80)
  expect(Date.now() - statSync(file).mtimeMs).toBeLessThan(10_000)
  const err = await waitFileLock(file, { staleMs: 60_000, waitMs: 150, pollMs: 20 }).catch((e) => e)
  expect(err).toBeInstanceOf(LockBusyError)
  held.release()
  ;(await waitFileLock(file, { staleMs: 60_000, waitMs: 150 })).release()
})
