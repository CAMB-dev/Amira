import { expect, test } from "bun:test"
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { userMessage } from "@amira/ai"
import { SessionInUseError, SessionStore, sessionLockFile } from "../src/session-store.ts"
import { finishWorker, startWorker, waitFor } from "./session-ownership-worker.ts"

function aliasOf(file: string, dir: string): string {
  const alias = path.join(dir, "alias.jsonl")
  try {
    symlinkSync(file, alias, "file")
    return alias
  } catch (error) {
    // Windows may disallow file symlinks; a directory junction needs no elevation.
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error
    const junction = path.join(dir, "alias-dir")
    symlinkSync(path.dirname(file), junction, "junction")
    return path.join(junction, path.basename(file))
  }
}

test("existing file aliases share both process ownership and the canonical lease path", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-session-path-"))
  const data = path.join(dir, "actual")
  const store = SessionStore.create({ cwd: dir, dir: data })
  let view: SessionStore | undefined
  try {
    store.appendMessage(userMessage("before alias"))
    const alias = aliasOf(store.file, dir)
    view = SessionStore.open(alias)
    expect(sessionLockFile(alias)).toBe(sessionLockFile(store.file))
    expect(view.file).toBe(store.file)
    store.claim()
    view.claim()
    expect(() => view!.appendDisplay({ type: "display", text: "ambiguous", level: "info" })).toThrow(
      "multiple live store owners",
    )
    view.release()
    view.append({ type: "display", text: "routed", level: "info" })
    store.appendMessage(userMessage("after alias"))
    expect(SessionStore.open(alias).entries).toEqual(store.entries)
  } finally {
    view?.release()
    store.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("unpublished sessions under directory aliases use the canonical parent before creation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-session-new-path-"))
  const actual = path.join(dir, "actual")
  const alias = path.join(dir, "alias")
  mkdirSync(actual)
  symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir")
  try {
    const canonical = SessionStore.create({ cwd: dir, dir: actual, id: "s_shared" })
    const view = SessionStore.create({ cwd: dir, dir: alias, id: "s_shared" })
    expect(view.file).toBe(canonical.file)
    expect(sessionLockFile(view.file)).toBe(sessionLockFile(canonical.file))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("another process's lease also excludes a file alias", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-session-alias-process-"))
  const store = SessionStore.create({ cwd: dir, dir: path.join(dir, "actual") })
  store.appendMessage(userMessage("existing"))
  const alias = aliasOf(store.file, dir)
  const worker = startWorker(dir, store.file, "hold")
  let view: SessionStore | undefined
  try {
    await waitFor(path.join(dir, "claimed"), worker)
    view = SessionStore.open(alias)
    expect(() => view!.claim()).toThrow(SessionInUseError)
    expect(() => view!.append({ type: "display", text: "blocked", level: "info" })).toThrow(SessionInUseError)
    expect(SessionStore.open(store.file).entries).toHaveLength(1)
  } finally {
    view?.release()
    writeFileSync(path.join(dir, "release"), "cleanup")
    await finishWorker(worker, dir)
  }
}, 8000)

test("hard-linked session files are refused rather than granting independent lock names", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-session-hardlink-"))
  const store = SessionStore.create({ cwd: dir, dir })
  let alias: SessionStore | undefined
  try {
    store.appendMessage(userMessage("existing"))
    const linked = path.join(dir, "hard-link.jsonl")
    linkSync(store.file, linked)
    expect(() => {
      alias = SessionStore.open(linked)
      alias.claim()
    }).toThrow(/hard.link/i)
    alias?.release()
    rmSync(linked)
    store.claim()
    store.appendMessage(userMessage("healthy after refusing the link"))
    expect(SessionStore.open(store.file).restore().messages).toHaveLength(2)
  } finally {
    alias?.release()
    store.release()
    rmSync(dir, { recursive: true, force: true })
  }
})
