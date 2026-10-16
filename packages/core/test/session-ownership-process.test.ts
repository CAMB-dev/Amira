import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { emptyUsage, userMessage } from "@amira/ai"
import { SPAWN_TEST_TIMEOUT_MS } from "../../../scripts/spawn-test.ts"
import { SessionInUseError, SessionStore, sessionLockFile } from "../src/session-store.ts"
import { finishWorker, startWorker, waitFor } from "./session-ownership-worker.ts"

test(
  "two processes refresh an opened snapshot after a retained temporary-lease print and before Agent history",
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amira-claim-process-"))
    const origin = SessionStore.create({ cwd: dir, dir })
    origin.appendMessage(userMessage("old model context"))
    const worker = startWorker(dir, origin.file, "resume")
    try {
      await waitFor(path.join(dir, "opened"), worker)
      origin.appendDisplay({ type: "display", text: "retained temporary print", level: "info" })
      expect(existsSync(sessionLockFile(origin.file))).toBe(false)
      writeFileSync(path.join(dir, "claim"), "go")
      await waitFor(path.join(dir, "result"), worker, 5000)
      const result = JSON.parse(readFileSync(path.join(dir, "result"), "utf8"))
      expect(result.errors).toEqual([])
      expect(result.disk).toEqual(result.memory)
      expect(result.disk).toHaveLength(5)
      expect(result.disk[0]).toEqual(userMessage("old model context"))
      expect(result.requests.map((messages: unknown[]) => messages.length)).toEqual([2, 4])
      expect(result.displays).toHaveLength(1)
      expect(result.displays[0].text).toBe("retained temporary print")
    } finally {
      writeFileSync(path.join(dir, "claim"), "cleanup")
      await finishWorker(worker, dir)
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a live process lease cannot be stolen by any append path even when its heartbeat looks stale",
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amira-live-owner-process-"))
    const origin = SessionStore.create({ cwd: dir, dir })
    origin.appendMessage(userMessage("old model context"))
    const worker = startWorker(dir, origin.file, "hold")
    try {
      await waitFor(path.join(dir, "claimed"), worker)
      const stale = new Date(0)
      utimesSync(sessionLockFile(origin.file), stale, stale)
      const usage = {
        type: "side_usage" as const,
        model: { provider: "mock", model: "m" },
        usage: { ...emptyUsage(), cost: 3 },
      }
      expect(() => origin.claim()).toThrow(SessionInUseError)
      expect(() => origin.append(usage)).toThrow(SessionInUseError)
      expect(() => origin.append({ type: "display", text: "blocked", level: "info" })).toThrow(
        SessionInUseError,
      )
      expect(() => origin.appendMessage(userMessage("blocked"))).toThrow(SessionInUseError)
      expect(() => origin.appendDurable({ type: "custom", ext: "test", data: "blocked" })).toThrow(
        SessionInUseError,
      )
      expect(SessionStore.open(origin.file).entries).toHaveLength(1)
      writeFileSync(path.join(dir, "release"), "go")
    } finally {
      writeFileSync(path.join(dir, "release"), "cleanup")
      await finishWorker(worker, dir)
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
