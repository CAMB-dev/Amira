import { expect, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SPAWN_TEST_TIMEOUT_MS, waitForSpawnWork } from "../../../scripts/spawn-test.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"
import { waitForFileLockCondition, waitForFileLockWorkerExit } from "./file-lock-test-waits.ts"

for (const held of [true, false]) {
  test(
    `worker publishes a complete ${held ? "successful" : "failed"} claim result atomically`,
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-worker-result-"))
      const store = SessionStore.create({ cwd: dir, dir })
      store.appendDisplay({ type: "display", level: "info", text: "saved" })
      const file = sessionLockFile(store.file)
      if (!held) fs.writeFileSync(file, `${process.pid}\n`)
      const worker = Bun.spawn(
        [
          process.execPath,
          "--preload",
          path.join(import.meta.dir, "file-lock-worker-result-preload.ts"),
          path.join(import.meta.dir, "file-lock-worker.ts"),
          file,
          dir,
          "session-contend",
        ],
        {
          windowsHide: true,
          env: Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
          ),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        },
      )
      const stderr = new Response(worker.stderr).text()
      async function waitFor(marker: string) {
        await waitForFileLockCondition(`result worker ${worker.pid}: ${marker}`, () => {
          if (fs.existsSync(path.join(dir, marker))) return true
          if (worker.exitCode !== null)
            throw new Error(`result worker exited before ${marker}: code=${worker.exitCode}`)
          return false
        }).catch(async (error) => {
          if (worker.exitCode !== null)
            throw new Error(
              `${error.message}\nstderr:\n${await waitForSpawnWork("worker stderr drain", stderr)}`,
            )
          throw error
        })
      }
      const result = path.join(dir, `result-${worker.pid}`)
      try {
        await waitFor(`ready-${worker.pid}`)
        fs.writeFileSync(path.join(dir, "contend"), "go")
        await waitFor("paused-result")
        // Match the existence-polling reader in the concurrent legacy recovery test.
        const observed = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, "utf8")) : undefined
        expect(observed).toBeUndefined()
        fs.writeFileSync(path.join(dir, "continue-result"), "go")
        await waitFor(`result-${worker.pid}`)
        const published = JSON.parse(fs.readFileSync(result, "utf8"))
        expect(published.held).toBe(held)
        if (!held) expect(published.error).toContain("older Amira build")
        fs.writeFileSync(path.join(dir, "release"), "go")
        expect(await waitForFileLockWorkerExit(worker, "result publication worker")).toBe(0)
        expect(await waitForSpawnWork("worker stderr drain", stderr)).toBe("")
      } finally {
        if (worker.exitCode === null) worker.kill()
        await waitForFileLockWorkerExit(worker, "owned result publication worker")
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}
