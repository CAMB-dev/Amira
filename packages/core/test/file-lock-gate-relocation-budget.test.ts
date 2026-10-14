import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  pendingGateCleanup,
  pendingOwnedGate,
  relocateReleasedGateCleanup,
  takeFilesystemGate,
} from "../src/file-lock-gate.ts"

function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "amira-gate-relocation-budget-")))
  const before = path.join(dir, "private")
  const after = path.join(dir, "public")
  fs.mkdirSync(before)
  const gate = path.join(before, "recording.lock.lease-gate")
  const publicGate = path.join(after, path.basename(gate))
  const release = takeFilesystemGate(path.join(before, "recording.lock"))
  if (!release) throw new Error("fixture gate was not acquired")
  return { dir, before, after, gate, publicGate, release }
}

test("relocation preserves an exhausted automatic retry budget but permits explicit cleanup", async () => {
  const { dir, before, after, gate, publicGate, release } = setup()
  const rename = fs.renameSync
  let attempts = 0
  const warnings: string[] = []
  const warning = spyOn(process, "emitWarning").mockImplementation((message) => {
    warnings.push(String(message))
  })
  const fault = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(from) === gate && String(to).startsWith(`${gate}.retired-`)) {
      attempts++
      throw Object.assign(new Error("retirement blocked"), { code: "EPERM" })
    }
    return rename(from, to)
  })
  try {
    release()
    const deadline = Date.now() + 3000
    while (!warnings.length && Date.now() < deadline) await Bun.sleep(10)
    expect(warnings).toHaveLength(1)
    expect(attempts).toBe(6)
    rename(before, after)
    relocateReleasedGateCleanup(before, after)
    expect(pendingOwnedGate(publicGate)).toBe(true)
    await Bun.sleep(150)
    expect(attempts).toBe(6)
    expect(warnings).toHaveLength(1)
    fault.mockRestore()
    release()
    expect(fs.existsSync(publicGate)).toBe(false)
    expect(pendingGateCleanup(publicGate)).toBe(false)
  } finally {
    fault.mockRestore()
    warning.mockRestore()
    release()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("relocation merges destination registry records without letting a displaced owner delete a new gate", () => {
  const { dir, before, after, gate, publicGate, release } = setup()
  fs.mkdirSync(after)
  const oldRelease = takeFilesystemGate(path.join(after, "recording.lock"))
  if (!oldRelease) throw new Error("destination gate was not acquired")
  const oldBytes = fs.readFileSync(path.join(publicGate, "owner.json"), "utf8")
  const newBytes = fs.readFileSync(path.join(gate, "owner.json"), "utf8")
  const displaced = path.join(dir, "displaced")
  const rename = fs.renameSync
  const fault = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(from) === gate && String(to).startsWith(`${gate}.retired-`))
      throw Object.assign(new Error("retirement blocked"), { code: "EPERM" })
    return rename(from, to)
  })
  try {
    release()
    rename(after, displaced)
    rename(before, after)
    relocateReleasedGateCleanup(before, after)
    expect(pendingOwnedGate(publicGate)).toBe(true)
    oldRelease()
    expect(fs.readFileSync(path.join(publicGate, "owner.json"), "utf8")).toBe(newBytes)
    expect(fs.readFileSync(path.join(displaced, path.basename(gate), "owner.json"), "utf8")).toBe(oldBytes)
    expect(pendingOwnedGate(publicGate)).toBe(true)
    fault.mockRestore()
    release()
    expect(fs.existsSync(publicGate)).toBe(false)
    expect(pendingGateCleanup(publicGate)).toBe(false)
  } finally {
    fault.mockRestore()
    release()
    oldRelease()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
