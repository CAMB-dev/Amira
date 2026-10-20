import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { tryFileLock } from "../src/file-lock.ts"

test("strict leases are initialized private before their canonical name is published", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amira-private-lock-"))
  const original = fs.openSync
  const modes: Parameters<typeof fs.openSync>[2][] = []
  const open = spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
    if (String(file).includes(".pending-")) modes.push(mode)
    return original(file, flags, mode)
  })
  const lock = tryFileLock(path.join(root, "owner.lock"), Infinity, undefined, true)
  try {
    expect(lock).toBeDefined()
    expect(modes).toEqual([0o600])
  } finally {
    open.mockRestore()
    lock?.release()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
