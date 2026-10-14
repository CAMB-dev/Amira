import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { takeFilesystemGate } from "../src/file-lock-gate.ts"
import { aliasedDirectory, filesystemGatePath } from "./file-lock-fixtures.ts"

for (const published of [true, false]) {
  test(`gate publication ${published ? "never removes a renamed staging path" : "cleans failed private staging without taking authority"}`, () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "amira-gate-publication-"))
    const dir = aliasedDirectory(root)
    const file = path.join(dir, "session.lock")
    const gate = filesystemGatePath(file)
    const rm = fs.rmSync
    const rename = fs.renameSync
    let removals = 0
    let unlock: (() => void) | undefined
    const removing = spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target).startsWith(`${gate}.pending-`)) {
        removals++
        if (published) throw Object.assign(new Error("stale staging path sharing error"), { code: "EPERM" })
      }
      return rm(target, options)
    })
    const renaming = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!published && String(to) === gate)
        throw Object.assign(new Error("lost publication"), { code: "EEXIST" })
      return rename(from, to)
    })
    try {
      unlock = takeFilesystemGate(file)
      if (published) {
        expect(unlock).toBeDefined()
        expect(removals).toBe(0)
        expect(fs.readdirSync(gate)).toEqual(["owner.json"])
        expect(takeFilesystemGate(file)).toBeUndefined()
      } else {
        expect(unlock).toBeUndefined()
        expect(removals).toBe(1)
        expect(fs.readdirSync(dir)).toEqual([])
      }
    } finally {
      removing.mockRestore()
      renaming.mockRestore()
      unlock?.()
      rm(root, { recursive: true, force: true })
    }
  })
}
