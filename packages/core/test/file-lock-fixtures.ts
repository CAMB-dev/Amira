import { expect } from "bun:test"
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { leaseOwner } from "../src/file-lock-owner.ts"

/** Gate operations resolve the parent, unlike lease operations on the caller's path. */
export function filesystemGatePath(file: string): string {
  return path.join(realpathSync(path.dirname(path.resolve(file))), `${path.basename(file)}.lease-gate`)
}

/** Exercise aliased parents even when the OS temporary directory is already canonical. */
export function aliasedDirectory(root: string): string {
  const physical = path.join(root, "physical")
  const alias = path.join(root, "alias")
  mkdirSync(physical)
  symlinkSync(physical, alias, "junction")
  return alias
}

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
