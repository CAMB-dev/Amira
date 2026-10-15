import { expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import path from "node:path"
import { pendingFileLockCleanup } from "../src/file-lock.ts"
import { pendingGateCleanup, takeFilesystemGate } from "../src/file-lock-gate.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"
import { fileLockWorkerReady, waitForFileLockCondition } from "./file-lock-test-waits.ts"

const [dir, phase, fault] = process.argv.slice(2)
if (!dir || !phase || !fault) throw new Error("missing retirement worker arguments")
await fileLockWorkerReady(dir)
const warnings: string[] = []
const warning = spyOn(process, "emitWarning").mockImplementation((message) => {
  warnings.push(String(message))
})
const store = SessionStore.create({ cwd: dir, dir })
const file = sessionLockFile(store.file)
const gate = `${file}.lease-gate`
const rename = fs.renameSync
let attempts = 0
let blocked = true
let armed = phase !== "release"
const hook = spyOn(fs, "renameSync").mockImplementation((...args) => {
  if (armed && args[0] === gate && String(args[1]).includes(".retired-")) {
    attempts++
    const fail = fault === "held" || fault === "pending" || fault === "permanent" ? blocked : attempts === 1
    if (fail)
      throw Object.assign(new Error("injected owner.json reader"), {
        code: fault.startsWith("E") ? fault : "EBUSY",
      })
  }
  return rename(...args)
})
try {
  if (phase === "release") {
    expect(store.claim()).toBe(true)
    armed = true
  } else expect(store.claim()).toBe(true)
  store.appendDisplay({ type: "display", level: "info", text: "complete first write" })
  const firstDisk = fs.readFileSync(store.file, "utf8")
  if (phase === "release") store.release()
  if (fault === "pending" || fault === "permanent") {
    // Deferred retries preserve the initialized exact owner without blocking claim/release.
    await waitForFileLockCondition(`${phase} ${fault} deferred retirement attempt`, () => attempts > 1)
    expect(attempts).toBeGreaterThan(1)
    expect(attempts).toBeLessThan(12)
    const record = fs.readFileSync(path.join(gate, "owner.json"), "utf8")
    expect(JSON.parse(record).pid).toBe(process.pid)
    expect(warnings).toEqual([])
    if (fault === "permanent") {
      await waitForFileLockCondition(
        `${phase} retirement exhausts its retry budget`,
        () => warnings.length > 0,
      )
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(gate)
      expect(warnings[0]).toContain("EBUSY")
      expect(fs.readFileSync(path.join(gate, "owner.json"), "utf8")).toBe(record)
      const count = attempts
      await Bun.sleep(250)
      expect(attempts).toBe(count)
    } else {
      await waitForFileLockCondition(`${phase} pending retirement keeps retrying`, () => attempts >= 3)
    }
    blocked = false
    // A later operation retries only this process's release-requested owner.
    const next = takeFilesystemGate(path.join(dir, ".", path.basename(file)))
    expect(next).toBeDefined()
    next!()
  } else {
    if (fault === "held") {
      await waitForFileLockCondition(`${phase} held reader causes deferred retries`, () => attempts >= 3)
      blocked = false
    }
    await waitForFileLockCondition(`${phase} ${fault} retires its gate`, () => !pendingGateCleanup(gate))
    expect(attempts).toBeGreaterThan(1)
    expect(warnings).toEqual([])
    expect(fs.existsSync(gate)).toBe(false)
  }
  hook.mockRestore()
  store.release()
  await waitForFileLockCondition(
    `${phase} ${fault} releases all owned cleanup`,
    () => !pendingFileLockCleanup(file),
  )
  expect(fs.readFileSync(store.file, "utf8")).toBe(firstDisk)
  expect(store.claim()).toBe(true)
  store.appendDisplay({ type: "display", level: "info", text: "complete second write" })
  store.release()
  expect(
    SessionStore.open(store.file).entries.map((entry) => (entry.type === "display" ? entry.text : null)),
  ).toEqual(["complete first write", "complete second write"])
  const disk = fs.readFileSync(store.file, "utf8")
  expect(disk.endsWith("\n")).toBe(true)
  const records = disk
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(records).toHaveLength(3)
  expect(records[0]).toEqual(store.header)
  expect(records.slice(1).map((entry) => entry.text)).toEqual([
    "complete first write",
    "complete second write",
  ])
  expect(fs.readdirSync(dir)).toEqual([path.basename(store.file)])
  if (fault !== "permanent") expect(warnings).toEqual([])
} finally {
  hook.mockRestore()
  store.release()
  warning.mockRestore()
}
