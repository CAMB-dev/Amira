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

function fixture() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "amira-gate-relocation-")))
  const before = path.join(dir, "private")
  const after = path.join(dir, "public")
  fs.mkdirSync(before)
  const lock = path.join(before, "recording.lock")
  const gate = `${lock}.lease-gate`
  const publicGate = path.join(after, path.basename(gate))
  const release = takeFilesystemGate(lock)
  if (!release) throw new Error("fixture gate was not acquired")
  return { dir, before, after, gate, publicGate, release }
}

for (const retired of [false, true]) {
  test(`released gate relocation preserves exact ownership and retryable release (retired: ${retired})`, () => {
    const { dir, before, after, gate, publicGate, release } = fixture()
    const rename = fs.renameSync
    const remove = fs.rmSync
    const fault = retired
      ? spyOn(fs, "rmSync").mockImplementation((file, options) => {
          if (String(file).startsWith(`${gate}.retired-`))
            throw Object.assign(new Error("retired removal blocked"), { code: "EPERM" })
          return remove(file, options)
        })
      : spyOn(fs, "renameSync").mockImplementation((from, to) => {
          if (String(from) === gate && String(to).startsWith(`${gate}.retired-`))
            throw Object.assign(new Error("retirement blocked"), { code: "EPERM" })
          return rename(from, to)
        })
    try {
      release()
      expect(pendingGateCleanup(gate)).toBe(true)
      rename(before, after)
      relocateReleasedGateCleanup(before, after)
      expect(pendingGateCleanup(gate)).toBe(false)
      expect(pendingGateCleanup(publicGate)).toBe(true)
      expect(pendingOwnedGate(publicGate)).toBe(!retired)
      fault.mockRestore()
      // The original release closure must follow its relocated registry key, not the old key.
      release()
      expect(pendingGateCleanup(publicGate)).toBe(false)
      expect(fs.readdirSync(after)).toEqual([])
    } finally {
      fault.mockRestore()
      release()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

for (const replacement of ["inode", "nonce", "parent", "junction", "metadata link", "active"] as const) {
  test(`relocation never grants cleanup authority to ${replacement} replacements or active gates`, () => {
    const { dir, before, after, gate, publicGate, release } = fixture()
    const rename = fs.renameSync
    const bytes = fs.readFileSync(path.join(gate, "owner.json"), "utf8")
    const fault = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === gate && String(to).startsWith(`${gate}.retired-`))
        throw Object.assign(new Error("retirement blocked"), { code: "EPERM" })
      return rename(from, to)
    })
    try {
      if (replacement !== "active") release()
      rename(before, after)
      const displaced = path.join(dir, "displaced")
      let expected = bytes
      if (replacement === "inode") {
        rename(publicGate, displaced)
        fs.mkdirSync(publicGate)
        fs.writeFileSync(path.join(publicGate, "owner.json"), bytes)
      } else if (replacement === "nonce") {
        expected = JSON.stringify({ ...JSON.parse(bytes), nonce: crypto.randomUUID() })
        fs.writeFileSync(path.join(publicGate, "owner.json"), expected)
      } else if (replacement === "parent") {
        rename(after, displaced)
        fs.mkdirSync(after)
        rename(path.join(displaced, path.basename(gate)), publicGate)
      } else if (replacement === "junction") {
        rename(after, displaced)
        fs.symlinkSync(displaced, after, process.platform === "win32" ? "junction" : "dir")
      } else if (replacement === "metadata link") {
        const metadata = path.join(publicGate, "owner.json")
        fs.writeFileSync(displaced, bytes)
        fs.unlinkSync(metadata)
        fs.symlinkSync(displaced, metadata, "file")
      }
      relocateReleasedGateCleanup(before, after)
      expect(pendingGateCleanup(publicGate)).toBe(false)
      expect(pendingOwnedGate(publicGate)).toBe(false)
      fault.mockRestore()
      release()
      expect(fs.readFileSync(path.join(publicGate, "owner.json"), "utf8")).toBe(expected)
      expect(fs.existsSync(publicGate)).toBe(true)
    } finally {
      fault.mockRestore()
      release()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
