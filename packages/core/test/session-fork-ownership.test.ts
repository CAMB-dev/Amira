import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { userMessage } from "@amira/ai"
import { tryFileLock } from "../src/file-lock.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"

test("fork publication and its finalization hold destination write authority", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "amira-fork-authority-"))
  const source = SessionStore.create({ cwd: dir, dir })
  source.appendMessage(userMessage("forked context"))
  const write = fs.writeFileSync
  let publicationObserved = false
  let competingClaimBlocked = false
  const hook = spyOn(fs, "writeFileSync").mockImplementation((...args) => {
    const target = args[0]
    if (typeof target === "string" && target.endsWith(".jsonl") && target !== source.file) {
      publicationObserved = true
      const competing = tryFileLock(sessionLockFile(target), 30_000, undefined, true)
      competingClaimBlocked = competing === undefined
      competing?.release()
    }
    write(...args)
  })
  try {
    const fork = source.fork()
    expect(publicationObserved).toBe(true)
    expect(competingClaimBlocked).toBe(true)
    expect(fs.existsSync(sessionLockFile(fork.file))).toBe(false)
    expect(SessionStore.open(fork.file).restore().messages).toEqual([userMessage("forked context")])
    fork.claim()
    fork.appendMessage(userMessage("healthy fork owner"))
    fork.release()
    expect(SessionStore.open(fork.file).restore().messages).toHaveLength(2)
  } finally {
    hook.mockRestore()
    source.release()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
