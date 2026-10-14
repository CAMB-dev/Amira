import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pendingGateCleanup, relocateReleasedGateCleanup, takeFilesystemGate } from "../src/file-lock-gate.ts"

test("partially removed retired debris retains cleanup ownership when its parent is restored", () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "amira-partial-gate-relocation-")))
  const before = path.join(dir, "private")
  const after = path.join(dir, "public")
  fs.mkdirSync(before)
  const gate = path.join(before, "recording.lock.lease-gate")
  const release = takeFilesystemGate(path.join(before, "recording.lock"))
  if (!release) throw new Error("fixture gate was not acquired")
  const remove = fs.rmSync
  const fault = spyOn(fs, "rmSync").mockImplementation((file, options) => {
    if (String(file).startsWith(`${gate}.retired-`)) {
      const metadata = path.join(String(file), "owner.json")
      if (fs.existsSync(metadata)) fs.unlinkSync(metadata)
      throw Object.assign(new Error("final directory removal blocked"), { code: "EPERM" })
    }
    return remove(file, options)
  })
  try {
    release()
    expect(pendingGateCleanup(gate)).toBe(true)
    const entries = fs.readdirSync(before)
    expect(entries).toHaveLength(1)
    expect(fs.readdirSync(path.join(before, entries[0]!))).toEqual([])
    fs.renameSync(before, after)
    const publicGate = path.join(after, path.basename(gate))
    relocateReleasedGateCleanup(before, after)
    expect(pendingGateCleanup(publicGate)).toBe(true)
    fault.mockRestore()
    release()
    expect(pendingGateCleanup(publicGate)).toBe(false)
    expect(fs.readdirSync(after)).toEqual([])
  } finally {
    fault.mockRestore()
    release()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
