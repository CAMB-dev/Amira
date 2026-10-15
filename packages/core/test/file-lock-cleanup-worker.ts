import { expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import path from "node:path"
import { pendingFileLockCleanup, tryFileLock } from "../src/file-lock.ts"
import { takeFilesystemGate } from "../src/file-lock-gate.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"
import { fileLockWorkerReady, waitForFileLockCondition } from "./file-lock-test-waits.ts"

const [dir, kind, mode, fault, retryDelay] = process.argv.slice(2)
if (!dir || !kind || !mode || !fault) throw new Error("missing file cleanup arguments")
await fileLockWorkerReady(dir)
if (retryDelay) {
  // Model a delayed Windows retry callback without delaying startup or the assertion's poll.
  const timeout = globalThis.setTimeout
  spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    if (args[1] === 100) args[1] = Number(retryDelay)
    return timeout(...args)
  }) as typeof setTimeout)
}
const parent = path.join(dir, "parent")
if (mode === "parent") {
  const originalParent = path.join(dir, "original-parent")
  fs.mkdirSync(originalParent)
  fs.symlinkSync(originalParent, parent, "junction")
} else fs.mkdirSync(parent)
let store = SessionStore.create({ cwd: parent, dir: parent })
if (mode === "resumed") {
  expect(store.claim()).toBe(true)
  store.appendDisplay({ type: "display", level: "info", text: "before resume" })
  store.release()
  store = SessionStore.open(store.file)
}
const file =
  kind === "private" && ["fresh", "resumed"].includes(mode)
    ? sessionLockFile(store.file)
    : path.join(parent, "session.lock")
// Capture the registry key before the parent junction can be replaced.
const canonicalFile = path.join(fs.realpathSync(parent), path.basename(file))
const warnings: string[] = []
spyOn(process, "emitWarning").mockImplementation((message) => {
  warnings.push(String(message))
})
const open = fs.openSync
const close = fs.closeSync
const rm = fs.rmSync
const link = fs.linkSync
let pending = ""
const active = new Set<number>()
let ownFd: number | undefined
let inNestedClaim = false
spyOn(fs, "openSync").mockImplementation((...args) => {
  const fd = open(...args)
  if (String(args[0]).startsWith(`${file}.pending-`)) {
    if (!inNestedClaim) {
      pending = String(args[0])
      ownFd = fd
    }
    active.add(fd)
  }
  return fd
})
spyOn(fs, "closeSync").mockImplementation((fd) => {
  const result = close(fd)
  active.delete(fd)
  return result
})
let armed = kind === "private"
let blocked = true
let attempts = 0
let nested = false
const target = () => (kind === "private" ? pending : file)
spyOn(fs, "rmSync").mockImplementation((...args) => {
  if (armed && String(args[0]) === target()) {
    attempts++
    if (mode === "reentrant") {
      nested = true
      inNestedClaim = true
      try {
        expect(tryFileLock(file, 1, undefined, true)).toBeUndefined()
      } finally {
        inNestedClaim = false
      }
    }
    const transient = ["direct", "prior-gate", "fresh", "resumed"].includes(mode)
    // A held reader spans real retry turns, regardless of scheduler/IO speed.
    if (blocked && (transient ? (fault === "held" ? attempts <= 2 : attempts === 1) : true))
      throw Object.assign(new Error("injected lease reader"), { code: fault === "held" ? "EBUSY" : fault })
  }
  return rm(...args)
})
let other: ReturnType<typeof tryFileLock>
let otherFd: number | undefined
let otherContents = ""
if (mode === "eexist") {
  armed = false
  other = tryFileLock(file, 1, undefined, true)
  expect(other).toBeDefined()
  otherFd = ownFd
  otherContents = fs.readFileSync(file, "utf8")
  armed = true
}
const publicationError = Object.assign(new Error("original publication error"), { code: "EIO" })
if (mode === "publish-error")
  spyOn(fs, "linkSync").mockImplementation((...args) => {
    if (args[1] === file) throw publicationError
    return link(...args)
  })
if (mode === "eexist" || mode === "publish-error") {
  if (mode === "eexist") expect(tryFileLock(file, 1, undefined, true)).toBeUndefined()
  else expect(() => tryFileLock(file, 1, undefined, true)).toThrow(publicationError)
  expect(active.has(ownFd!)).toBe(false)
  if (other) {
    expect(active.has(otherFd!)).toBe(true)
    expect(fs.readFileSync(file, "utf8")).toBe(otherContents)
  }
  blocked = false
  await waitForFileLockCondition("unpublished private debris removal", () => !fs.existsSync(pending))
  expect(fs.existsSync(pending)).toBe(false)
  expect(warnings).toEqual([])
  other?.release()
  expect(active.size).toBe(0)
  expect(fs.readdirSync(parent)).toEqual([])
  process.exit(0)
}
let lease: ReturnType<typeof tryFileLock>
if (kind === "private" && ["fresh", "resumed"].includes(mode)) {
  expect(store.claim()).toBe(true)
  expect(active.size).toBe(1)
  store.appendDisplay({ type: "display", level: "info", text: "after claim" })
  const disk = fs.readFileSync(store.file, "utf8")
  await waitForFileLockCondition("claimed private debris removal", () => !fs.existsSync(pending))
  expect(fs.existsSync(pending)).toBe(false)
  expect(active.size).toBe(1)
  expect(warnings).toEqual([])
  store.release()
  expect(active.size).toBe(0)
  expect(fs.readFileSync(store.file, "utf8")).toBe(disk)
  const resumed = SessionStore.open(store.file)
  expect(resumed.claim()).toBe(true)
  resumed.appendDisplay({ type: "display", level: "info", text: "later resume" })
  resumed.release()
  expect(
    SessionStore.open(store.file)
      .entries.filter((entry) => entry.type === "display")
      .map((entry) => entry.text),
  ).toEqual(
    mode === "resumed" ? ["before resume", "after claim", "later resume"] : ["after claim", "later resume"],
  )
  expect(fs.readdirSync(parent)).toEqual([path.basename(store.file)])
  process.exit(0)
}
lease = tryFileLock(file, 1, 10, true)
expect(lease).toBeDefined()
expect(active.size).toBe(1)
const original = fs.readFileSync(file, "utf8")
if (kind === "lease") {
  armed = true
  if (mode === "prior-gate") {
    const unlock = takeFilesystemGate(file)!
    lease!.release()
    expect(active.size).toBe(1)
    unlock()
  } else lease!.release()
}
if (mode.startsWith("exit-")) {
  blocked = mode === "exit-failure"
  process.on("exit", () => {
    // Private debris cleanup never closes an active canonical lease descriptor.
    expect(active.size).toBe(kind === "lease" ? 0 : 1)
    if (blocked) {
      expect(fs.readFileSync(target(), "utf8")).toBe(original)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(fault)
    } else {
      expect(fs.existsSync(target())).toBe(false)
      expect(warnings).toEqual([])
      if (kind === "private") expect(fs.readFileSync(file, "utf8")).toBe(original)
    }
  })
  process.exit(0)
}
if (mode === "direct" || mode === "prior-gate") {
  await waitForFileLockCondition(`lease unlink after ${mode} (${fault})`, () => !fs.existsSync(file))
  expect(fs.existsSync(file)).toBe(false)
  expect(active.size).toBe(0)
  expect(attempts).toBe(2)
  expect(warnings).toEqual([])
} else if (["replacement", "tampered", "parent", "canonical-replacement"].includes(mode)) {
  const destination = target()
  if (mode === "parent") {
    fs.renameSync(parent, path.join(dir, "moved"))
    fs.mkdirSync(parent)
    fs.writeFileSync(destination, "untouched replacement")
  } else if (mode === "canonical-replacement") {
    fs.renameSync(file, `${file}.displaced`)
    fs.writeFileSync(file, "untouched replacement")
  } else if (mode === "replacement") {
    fs.renameSync(destination, `${destination}.displaced`)
    fs.writeFileSync(destination, "untouched replacement")
  } else fs.writeFileSync(destination, "untouched replacement")
  blocked = false
  await waitForFileLockCondition(
    `${kind} cleanup abandons ${mode} replacement`,
    () => !pendingFileLockCleanup(canonicalFile),
  )
  expect(fs.readFileSync(mode === "canonical-replacement" ? file : destination, "utf8")).toBe(
    "untouched replacement",
  )
  expect(warnings).toEqual([])
  if (kind === "private") {
    expect(active.size).toBe(1)
    lease!.release()
  }
  expect(active.size).toBe(0)
  if (mode === "canonical-replacement") expect(fs.existsSync(pending)).toBe(false)
} else {
  // Ten 100ms delays exclude time spent inside cleanup (including reentrant I/O).
  // Await exhaustion itself rather than assuming every platform finishes in 1250ms.
  await waitForFileLockCondition(
    `${kind} owned cleanup exhausts retry budget (${mode})`,
    () => warnings.length > 0,
  )
  expect(attempts).toBe(11)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain(target())
  expect(warnings[0]).toContain(fault)
  expect(active.size).toBe(kind === "lease" ? 0 : 1)
  expect(fs.readFileSync(target(), "utf8")).toBe(original)
  const count = attempts
  // Negative observation window: completion is known from the exhaustion warning above.
  await Bun.sleep(200)
  expect(attempts).toBe(count)
  if (kind === "lease") {
    // A still-denied explicit release gets one attempt, never a fresh timer budget.
    lease!.release()
    expect(attempts).toBe(count + 1)
    await Bun.sleep(200)
    expect(attempts).toBe(count + 1)
    expect(warnings).toHaveLength(1)
  }
  blocked = false
  if (mode === "acquire") {
    if (kind === "private") {
      expect(tryFileLock(file, 1, undefined, true)).toBeUndefined()
      expect(fs.readFileSync(file, "utf8")).toBe(original)
      lease!.release()
    } else {
      const next = tryFileLock(file, 1, undefined, true)
      expect(next).toBeDefined()
      const nextContents = fs.readFileSync(file, "utf8")
      lease!.release()
      expect(fs.readFileSync(file, "utf8")).toBe(nextContents)
      next!.release()
    }
  } else lease!.release()
  expect(fs.existsSync(target())).toBe(false)
  expect(active.size).toBe(0)
  expect(nested).toBe(mode === "reentrant")
}
