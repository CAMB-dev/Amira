import { expect } from "bun:test"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { leaseOwner } from "../src/file-lock-owner.ts"

/** The caller supplies a child PID whose exit it has awaited and independently verified. */
export function deadLease(file: string, pid: number): string {
  const owner = { ...leaseOwner(), pid }
  expect(owner.host).not.toBeNull()
  if (process.platform === "linux") {
    expect(owner.boot).not.toBeNull()
    expect(owner.pidNamespace).not.toBeNull()
  }
  const contents = `${pid}\n${owner.nonce}\n${JSON.stringify(owner)}\n`
  writeFileSync(file, contents)
  return contents
}

/** Ordinary release leaves EXACTLY nothing: no staging, gates, leases or tombstones. */
export function expectReleasedArtifacts(dir: string, files: string[]): void {
  expect(readdirSync(dir)).toEqual([])
  for (const file of files) {
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.lease-gate`)).toBe(false)
  }
}
