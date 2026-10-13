import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { userMessage } from "@amira/ai"
import { deleteSession } from "../src/session-list.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"
import { finishWorker, startWorker, waitFor } from "./session-ownership-worker.ts"

test("deletion cannot mutate a session held by another live view in this process", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-delete-owned-"))
  const owner = SessionStore.create({ cwd: dir, dir })
  owner.appendMessage(userMessage("before deletion attempt"))
  owner.claim()
  try {
    expect(() => deleteSession(dir, owner.id, undefined, dir)).toThrow("open")
    expect(existsSync(owner.file)).toBe(true)
    owner.appendMessage(userMessage("owner still saves"))
    expect(SessionStore.open(owner.file).restore().messages).toEqual(owner.restore().messages)
  } finally {
    owner.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("deletion respects strict foreign ownership even when a live heartbeat looks stale", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-delete-foreign-"))
  const store = SessionStore.create({ cwd: dir, dir })
  store.appendMessage(userMessage("foreign owner"))
  const worker = startWorker(dir, store.file, "hold")
  try {
    await waitFor(path.join(dir, "claimed"), worker)
    utimesSync(sessionLockFile(store.file), new Date(0), new Date(0))
    expect(() => deleteSession(dir, store.id, undefined, dir)).toThrow("open")
    expect(existsSync(store.file)).toBe(true)
    expect(SessionStore.open(store.file).restore().messages).toEqual([userMessage("foreign owner")])
  } finally {
    writeFileSync(path.join(dir, "release"), "cleanup")
    await finishWorker(worker, dir)
  }
}, 8000)
