import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { tryFileLock } from "../src/file-lock.ts"
import type { LeaseDomain } from "../src/file-lock-domain.ts"
import { type LeasePolicy, leaseOwner, strictOwnerState } from "../src/file-lock-owner.ts"

const domain: LeaseDomain = {
  platform: process.platform,
  host: "machine-local-host",
  legacyHost: null,
  boot: null,
  pidNamespace: null,
}
const starts = new Map<number, string | undefined>()
let probes = 0
const policy: LeasePolicy = {
  domain,
  start(pid) {
    probes++
    return starts.get(pid)
  },
}
const record = (owner: object & { pid: number; nonce: string }) =>
  `${owner.pid}\n${owner.nonce}\n${JSON.stringify(owner)}\n`

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-lease-policy-"))
  starts.clear()
  starts.set(process.pid, "start-now")
  probes = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))

test("a policy lease records its machine-local host and the holder's start identity", () => {
  const owner = leaseOwner(policy)
  expect(owner).toMatchObject({ v: 2, pid: process.pid, host: domain.host, boot: null, start: "start-now" })
  expect(leaseOwner()).not.toHaveProperty("start")
})

test("the recorded start identity decides liveness, including for this process's own PID", () => {
  const owner = leaseOwner(policy)
  expect(strictOwnerState(record(owner), policy)).toBe("live")
  // The same PID with another start time is an earlier holder whose PID was reused.
  starts.set(process.pid, "start-later")
  expect(strictOwnerState(record(owner), policy)).toBe("dead")
  starts.set(process.pid, undefined)
  expect(strictOwnerState(record(owner), policy)).toBe("dead")
  const failing: LeasePolicy = {
    domain,
    start: () => {
      throw new Error("probe failed")
    },
  }
  expect(strictOwnerState(record(owner), failing)).toBe("unknown")
})

test("a foreign host never reaches the start probe", () => {
  const owner = { ...leaseOwner(policy), host: "another-host" }
  probes = 0
  expect(strictOwnerState(record(owner), policy)).toBe("unknown")
  expect(probes).toBe(0)
})

test("records without a start identity keep the default PID probe", () => {
  const owner = { ...leaseOwner(), host: domain.host, boot: null, pidNamespace: null }
  starts.set(process.pid, undefined)
  expect(strictOwnerState(record(owner), policy)).toBe("live")
})

test("without a policy a start field is ignored and the default domain applies", () => {
  const owner = { ...leaseOwner(), start: "start-earlier" }
  expect(strictOwnerState(record(owner))).toBe("live")
})

test("strict acquisition recovers a reused-PID lease only under the policy", () => {
  const file = path.join(dir, "owner.lock")
  const stale = { ...leaseOwner(policy), start: "start-earlier" }
  writeFileSync(file, record(stale))
  expect(tryFileLock(file, Infinity, undefined, true)).toBeUndefined()
  expect(readFileSync(file, "utf8")).toBe(record(stale))
  const lock = tryFileLock(file, Infinity, undefined, true, undefined, policy)
  expect(lock).toBeDefined()
  const fresh = JSON.parse(readFileSync(file, "utf8").split("\n")[2]!)
  expect(fresh).toMatchObject({ pid: process.pid, host: domain.host, start: "start-now" })
  expect(fresh.nonce).not.toBe(stale.nonce)
  // The live holder is not recoverable by another policy participant.
  expect(tryFileLock(file, Infinity, undefined, true, undefined, policy)).toBeUndefined()
  lock!.release()
  expect(() => readFileSync(file)).toThrow()
})
