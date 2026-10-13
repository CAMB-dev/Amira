import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { emptyUsage, userMessage } from "@amira/ai"
import { SessionConflictError, SessionStore, sessionLockFile } from "../src/session-store.ts"

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-session-authority-"))
  const store = SessionStore.create({ cwd: dir, dir })
  store.appendMessage(userMessage("old context"))
  return { dir, store }
}

const charge = {
  type: "side_usage" as const,
  model: { provider: "mock", model: "m" },
  usage: { ...emptyUsage(), cost: 3 },
}

test("a released generic usage append follows the resumed writer without poisoning its context", () => {
  const { dir, store } = fixture()
  let resumed: SessionStore | undefined
  try {
    store.claim()
    store.release()
    resumed = SessionStore.open(store.file)
    resumed.claim()
    store.append(charge)
    resumed.appendMessage(userMessage("new context"))
    expect(SessionStore.open(store.file).restore().messages).toEqual(resumed.restore().messages)
    expect(resumed.entries.filter((entry) => entry.type === "side_usage")).toHaveLength(1)
    expect(() => store.appendMessage(userMessage("captured old context"))).toThrow(SessionConflictError)
    expect(() => store.append({ type: "custom", ext: "old context", data: {} })).toThrow(SessionConflictError)
    expect(() => store.appendDurable({ type: "custom", ext: "old context", data: {} })).toThrow(
      SessionConflictError,
    )
    store.appendDurable(charge)
    resumed.appendMessage(userMessage("after durable metadata"))
    expect(SessionStore.open(store.file).restore().messages).toEqual(resumed.restore().messages)
    expect(SessionStore.open(store.file).entries.filter((entry) => entry.type === "side_usage")).toHaveLength(
      2,
    )
  } finally {
    resumed?.release()
    store.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("claim refreshes an earlier open before restoring model history", () => {
  const { dir, store } = fixture()
  const earlier = SessionStore.open(store.file)
  try {
    store.appendMessage(userMessage("arrived before claim"))
    store.appendDisplay({ type: "display", text: "retained print", level: "info" })
    earlier.claim()
    expect(earlier.restore().messages).toEqual([
      userMessage("old context"),
      userMessage("arrived before claim"),
    ])
    earlier.appendMessage(userMessage("after claim"))
    expect(SessionStore.open(store.file).restore().messages).toEqual(earlier.restore().messages)
  } finally {
    earlier.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("claim failures do not finalize ownership for deleted or replaced origins", () => {
  const { dir, store } = fixture()
  try {
    const original = readFileSync(store.file, "utf8")
    rmSync(store.file)
    expect(() => store.claim()).toThrow()
    expect(() => store.append(charge)).toThrow()
    expect(existsSync(store.file)).toBe(false)
    expect(existsSync(sessionLockFile(store.file))).toBe(false)
    const foreign = original.replace(store.id, "s_foreign")
    writeFileSync(store.file, foreign)
    expect(() => store.claim()).toThrow("different session")
    expect(() => store.appendDisplay({ type: "display", text: "must not write", level: "info" })).toThrow(
      "different session",
    )
    expect(readFileSync(store.file, "utf8")).toBe(foreign)
    expect(existsSync(sessionLockFile(store.file))).toBe(false)
    const valid = SessionStore.open(store.file)
    valid.claim()
    valid.release()
    expect(existsSync(sessionLockFile(store.file))).toBe(false)
  } finally {
    store.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unwritten origin never appends its lazy header to a replacement file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-lazy-authority-"))
  const store = SessionStore.create({ cwd: dir, dir })
  try {
    store.append({ type: "custom", ext: "pending", data: "keep" })
    const replacement = `${JSON.stringify({ ...store.header, id: "s_foreign" })}\n`
    writeFileSync(store.file, replacement)
    expect(() => store.claim()).toThrow()
    expect(existsSync(sessionLockFile(store.file))).toBe(false)
    expect(() =>
      store.appendDisplay({ type: "display", text: "must not duplicate header", level: "info" }),
    ).toThrow()
    expect(readFileSync(store.file, "utf8")).toBe(replacement)
    expect(store.entries).toHaveLength(1)
  } finally {
    store.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("claimed read views are ambiguous for metadata until their references are released", () => {
  const { dir, store } = fixture()
  const reader = SessionStore.open(store.file)
  try {
    store.claim()
    reader.claim()
    reader.claim()
    expect(() => store.append(charge)).toThrow("multiple live store owners")
    reader.release()
    expect(() => store.appendDisplay({ type: "display", text: "still ambiguous", level: "info" })).toThrow(
      "multiple live store owners",
    )
    reader.release()
    store.append(charge)
    store.release()
    reader.release()
    expect(existsSync(sessionLockFile(store.file))).toBe(false)
    const next = SessionStore.open(store.file)
    next.claim()
    next.appendMessage(userMessage("next owner"))
    next.release()
    expect(existsSync(sessionLockFile(store.file))).toBe(false)
    expect(SessionStore.open(store.file).restore().messages).toHaveLength(2)
  } finally {
    reader.release()
    reader.release()
    store.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a lease paused before writing its pid cannot be stolen by age", () => {
  const { dir, store } = fixture()
  try {
    writeFileSync(sessionLockFile(store.file), "")
    utimesSync(sessionLockFile(store.file), new Date(0), new Date(0))
    expect(() => store.claim()).toThrow()
    expect(() => store.append(charge)).toThrow()
    expect(readFileSync(sessionLockFile(store.file), "utf8")).toBe("")
    expect(SessionStore.open(store.file).entries).toHaveLength(1)
  } finally {
    store.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("every generic append path refuses a lease not held by this process", () => {
  const { dir, store } = fixture()
  try {
    // A live pid recorded without a process-local claim is not our authority.
    writeFileSync(sessionLockFile(store.file), `${process.pid}\n`)
    expect(() => store.append(charge)).toThrow()
    expect(() => store.appendMessage(userMessage("blocked"))).toThrow()
    expect(() => store.appendDurable({ type: "custom", ext: "test", data: "blocked" })).toThrow()
    expect(SessionStore.open(store.file).entries).toHaveLength(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
