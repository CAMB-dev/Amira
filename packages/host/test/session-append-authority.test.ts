import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { userMessage } from "@amira/ai"
import {
  SessionConflictError,
  SessionInUseError,
  SessionStore,
  sessionLockFile,
} from "../../core/src/session-store.ts"
import { deleteSession } from "../src/session-list.ts"

function fixture() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "amira-append-authority-"))
  const store = SessionStore.create({ cwd: dir, dir })
  store.appendMessage(userMessage("old"))
  return { dir, store }
}

test("held appends do not read history, but claim still does", () => {
  const { dir, store } = fixture()
  const read = spyOn(fs, "readFileSync")
  const readTail = fs.readSync
  const tail = spyOn(fs, "readSync").mockImplementation(((
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    expect(length).toBeLessThanOrEqual(4096)
    return readTail(fd, buffer, offset, length, position)
  }) as typeof readTail)
  try {
    store.claim()
    expect(read.mock.calls.some(([file]) => file === store.file)).toBe(true)
    read.mockClear()
    const original = store.entries[0]
    store.appendMessage(userMessage("x".repeat(8192)))
    store.appendDisplay({ type: "display", text: "notice", level: "info" })
    store.rename("title")
    expect(read).not.toHaveBeenCalled()
    expect(tail).toHaveBeenCalledTimes(3)
    expect(store.entries[0]).toBe(original)
  } finally {
    read.mockRestore()
    tail.mockRestore()
    store.release()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("held appends detect a same-tick tail rewrite even when stat timestamps collide", () => {
  const { dir, store } = fixture()
  try {
    store.claim()
    store.appendMessage(userMessage("x".repeat(8192)))
    store.appendMessage(userMessage("tail-old"))
    const messages = store.restore().messages
    const known = fs.statSync(store.file, { bigint: true })
    const raw = fs.readFileSync(store.file, "utf8")
    const changed = raw.replace('"text":"tail-old"', '"text":"tail-new"')
    fs.writeFileSync(store.file, changed)
    // Windows can preserve both timestamps for same-tick in-place edits. Pin that
    // collision rather than making the regression test depend on clock resolution.
    const stat = fs.statSync
    const hook = spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof stat>) => {
      const current = stat(...args)
      if (current && args[0] === store.file && typeof current.size === "bigint")
        return { ...current, mtimeNs: known.mtimeNs, ctimeNs: known.ctimeNs }
      return current
    }) as typeof stat)
    try {
      expect(() => store.appendMessage(userMessage("must not merge"))).toThrow(SessionConflictError)
      expect(fs.readFileSync(store.file, "utf8")).toBe(changed)
      expect(store.restore().messages).toEqual(messages)
    } finally {
      hook.mockRestore()
    }
  } finally {
    store.release()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

for (const replacement of [false, true]) {
  test(`held appends detect same-size ${replacement ? "replacement" : "edit"} with restored mtime`, () => {
    const { dir, store } = fixture()
    try {
      store.claim()
      const known = fs.statSync(store.file)
      const raw = fs.readFileSync(store.file, "utf8")
      const changed = raw.replace('"text":"old"', '"text":"new"')
      expect(Buffer.byteLength(changed)).toBe(known.size)
      if (replacement) {
        const next = path.join(dir, "replacement.jsonl")
        fs.writeFileSync(next, changed)
        fs.utimesSync(next, known.atime, known.mtime)
        fs.renameSync(next, store.file)
      } else {
        fs.writeFileSync(store.file, changed)
        fs.utimesSync(store.file, known.atime, known.mtime)
      }
      expect(() => store.appendMessage(userMessage("must not merge"))).toThrow(SessionConflictError)
      expect(fs.readFileSync(store.file, "utf8")).toBe(changed)
      expect(store.restore().messages).toEqual([userMessage("old")])
    } finally {
      store.release()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("transient append and fsync exclude claims and deletion until the write returns", () => {
  const { dir, store } = fixture()
  const contender = SessionStore.open(store.file)
  const file = sessionLockFile(store.file)
  const verify = () => {
    expect(fs.existsSync(file)).toBe(true)
    expect(() => contender.claim()).toThrow(SessionInUseError)
    expect(() => contender.appendMessage(userMessage("blocked"))).toThrow(SessionInUseError)
    expect(() => deleteSession(dir, store.id, undefined, dir)).toThrow(/cannot delete session|EPERM/)
  }
  const append = fs.appendFileSync
  const appendHook = spyOn(fs, "appendFileSync").mockImplementation((...args) => {
    if (args[0] === store.file) verify()
    return append(...args)
  })
  const sync = fs.fsyncSync
  const syncHook = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    verify()
    return sync(fd)
  })
  try {
    store.appendDurable({ type: "custom", ext: "journal", data: "durable" })
    expect(fs.readdirSync(dir)).toEqual([path.basename(store.file)])
    contender.claim()
    expect(contender.entries).toEqual(store.entries)
  } finally {
    appendHook.mockRestore()
    syncHook.mockRestore()
    contender.release()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a post-append stat failure cannot cache authority over an unrecorded entry", () => {
  const { dir, store } = fixture()
  const append = fs.appendFileSync
  const stat = fs.statSync
  const failure = Object.assign(new Error("stat failed"), { code: "EACCES" })
  let written = false
  const appendHook = spyOn(fs, "appendFileSync").mockImplementation((...args) => {
    append(...args)
    written = true
  })
  const statHook = spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof stat>) => {
    if (written && args[0] === store.file) throw failure
    return stat(...args)
  }) as typeof stat)
  try {
    expect(() => store.appendMessage(userMessage("landed"))).toThrow(failure)
    expect(store.entries).toHaveLength(1)
    appendHook.mockRestore()
    statHook.mockRestore()
    expect(() => store.appendMessage(userMessage("must not skip landed entry"))).toThrow(SessionConflictError)
    expect(SessionStore.open(store.file).restore().messages).toEqual([
      userMessage("old"),
      userMessage("landed"),
    ])
    expect(fs.readdirSync(dir)).toEqual([path.basename(store.file)])
  } finally {
    appendHook.mockRestore()
    statHook.mockRestore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("failed transient writes release the gate and never add an in-memory entry", () => {
  const { dir, store } = fixture()
  const failure = new Error("append failed")
  const append = spyOn(fs, "appendFileSync").mockImplementation(() => {
    throw failure
  })
  try {
    expect(() => store.appendMessage(userMessage("failed"))).toThrow(failure)
    expect(store.entries).toHaveLength(1)
    expect(fs.readdirSync(dir)).toEqual([path.basename(store.file)])
    append.mockRestore()
    store.appendMessage(userMessage("retry"))
    expect(SessionStore.open(store.file).entries).toEqual(store.entries)
  } finally {
    append.mockRestore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
