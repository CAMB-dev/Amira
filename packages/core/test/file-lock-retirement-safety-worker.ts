import { expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import path from "node:path"
import { tryFileLock } from "../src/file-lock.ts"
import { takeFilesystemGate } from "../src/file-lock-gate.ts"
import { filesystemGatePath } from "./file-lock-fixtures.ts"

const [dir, mode] = process.argv.slice(2)
if (!dir || !mode) throw new Error("missing gate safety arguments")
const parent = path.join(dir, "parent")
fs.mkdirSync(parent)
const file = path.join(parent, "session.lock")
const gate = filesystemGatePath(file)
const warnings: string[] = []
spyOn(process, "emitWarning").mockImplementation((message) => {
  warnings.push(String(message))
})
const unlock = takeFilesystemGate(file)!
expect(unlock).toBeDefined()
const record = fs.readFileSync(path.join(gate, "owner.json"), "utf8")
const alias = path.join(dir, "alias")
const aliasFile = path.join(alias, process.platform === "win32" ? "SESSION.LOCK" : "session.lock")
if (mode === "alias") {
  fs.symlinkSync(parent, alias, "junction")
  expect(takeFilesystemGate(aliasFile)).toBeUndefined()
  expect(fs.readFileSync(path.join(gate, "owner.json"), "utf8")).toBe(record)
}
const rename = fs.renameSync
let blocked = true
let nested = false
let attempts = 0
const hook = spyOn(fs, "renameSync").mockImplementation((...args) => {
  if (args[0] === gate && String(args[1]).includes(".retired-")) {
    attempts++
    if (mode === "reentrant") {
      nested = true
      expect(takeFilesystemGate(file)).toBeUndefined()
      expect(fs.readFileSync(path.join(gate, "owner.json"), "utf8")).toBe(record)
    } else if (blocked) throw Object.assign(new Error("held reader"), { code: "EPERM" })
  }
  return rename(...args)
})
if (mode === "exit-success" || mode === "exit-failure") {
  unlock()
  expect(warnings).toEqual([])
  blocked = mode === "exit-failure"
  process.on("exit", () => {
    if (blocked) {
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(gate)
      expect(warnings[0]).toContain("EPERM")
      expect(fs.readFileSync(path.join(gate, "owner.json"), "utf8")).toBe(record)
    } else {
      expect(warnings).toEqual([])
      expect(fs.readdirSync(parent)).toEqual([])
    }
  })
  process.exit(0)
} else if (mode === "normal") {
  blocked = false
  unlock()
  for (let i = 0; i < 120; i++) {
    const held = tryFileLock(file, 1, undefined, true)
    expect(held).toBeDefined()
    held!.release()
    expect(fs.readdirSync(parent)).toEqual([])
  }
} else if (mode === "active" || mode === "reentrant") {
  expect(takeFilesystemGate(file)).toBeUndefined()
  expect(fs.readFileSync(path.join(gate, "owner.json"), "utf8")).toBe(record)
  blocked = false
  unlock()
  expect(nested).toBe(mode === "reentrant")
  expect(fs.readdirSync(parent)).toEqual([])
} else if (mode === "private") {
  blocked = false
  const rm = fs.rmSync
  let privateBlocked = true
  let privateAttempts = 0
  const removal = spyOn(fs, "rmSync").mockImplementation((...args) => {
    if (String(args[0]).includes(".retired-")) {
      privateAttempts++
      if (privateBlocked) throw Object.assign(new Error("private reader"), { code: "EACCES" })
    }
    return rm(...args)
  })
  unlock()
  expect(fs.existsSync(gate)).toBe(false)
  const replacement = takeFilesystemGate(file)!
  expect(replacement).toBeDefined()
  const nextRecord = fs.readFileSync(path.join(gate, "owner.json"), "utf8")
  privateBlocked = false
  await Bun.sleep(200)
  expect(privateAttempts).toBeGreaterThan(1)
  expect(fs.readFileSync(path.join(gate, "owner.json"), "utf8")).toBe(nextRecord)
  expect(fs.readdirSync(parent)).toEqual(["session.lock.lease-gate"])
  removal.mockRestore()
  replacement()
} else {
  unlock()
  await Bun.sleep(60)
  expect(fs.readFileSync(path.join(gate, "owner.json"), "utf8")).toBe(record)
  expect(attempts).toBeGreaterThan(1)
  if (mode === "closure") {
    blocked = false
    unlock()
    expect(fs.readdirSync(parent)).toEqual([])
  } else if (mode === "alias") {
    blocked = false
    const next = takeFilesystemGate(aliasFile)
    expect(next).toBeDefined()
    next!()
    expect(fs.readdirSync(parent)).toEqual([])
  } else if (mode === "replacement") {
    fs.renameSync(gate, `${gate}.displaced`)
    // Publish at another key and move it into place, without consulting/cancelling the
    // original key's deferred retry. The timer itself must reject this replacement.
    const replacementFile = path.join(parent, "replacement.lock")
    const replacementGate = `${replacementFile}.lease-gate`
    const replacement = takeFilesystemGate(replacementFile)!
    expect(replacement).toBeDefined()
    fs.renameSync(replacementGate, gate)
    const nextRecord = fs.readFileSync(path.join(gate, "owner.json"), "utf8")
    blocked = false
    await Bun.sleep(200)
    unlock()
    expect(fs.readFileSync(path.join(gate, "owner.json"), "utf8")).toBe(nextRecord)
    fs.renameSync(gate, replacementGate)
    replacement()
    expect(fs.readdirSync(parent)).toEqual(["session.lock.lease-gate.displaced"])
  } else if (mode === "tampered") {
    const changed = JSON.stringify({ ...JSON.parse(record), nonce: "unverifiable-replacement" })
    fs.writeFileSync(path.join(gate, "owner.json"), changed)
    blocked = false
    await Bun.sleep(200)
    unlock()
    expect(takeFilesystemGate(file)).toBeUndefined()
    expect(fs.readFileSync(path.join(gate, "owner.json"), "utf8")).toBe(changed)
    expect(fs.readdirSync(parent)).toEqual(["session.lock.lease-gate"])
  } else if (mode === "parent") {
    fs.renameSync(parent, path.join(dir, "moved"))
    fs.mkdirSync(parent)
    fs.writeFileSync(file, "untouched replacement")
    blocked = false
    await Bun.sleep(200)
    unlock()
    expect(fs.readdirSync(parent)).toEqual(["session.lock"])
    expect(fs.readFileSync(file, "utf8")).toBe("untouched replacement")
    expect(fs.readFileSync(path.join(dir, "moved", "session.lock.lease-gate", "owner.json"), "utf8")).toBe(
      record,
    )
  } else throw new Error(`unknown gate safety mode ${mode}`)
}
hook.mockRestore()
expect(warnings).toEqual([])
