import { expect, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SPAWN_TEST_TIMEOUT_MS, stopSpawn, waitForSpawnExit } from "../../../scripts/spawn-test.ts"
import { READER_READY_TIMEOUT_MS } from "../../core/test/file-lock-reader-fixture.ts"

for (const boundary of process.platform === "win32" ? ["resume", "startup"] : []) {
  test(
    `Windows reader: awaited CLI ${boundary} survives disposal without blocking timers`,
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-acquire-reader-"))
      const worker = Bun.spawn(
        [
          process.execPath,
          "--preload",
          path.join(import.meta.dir, "../../core/test/file-lock-worker-preload.ts"),
          path.join(import.meta.dir, "session-acquisition-reader-worker.ts"),
          dir,
          boundary,
        ],
        {
          env: Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
          ),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const stdout = new Response(worker.stdout).text()
      const stderr = new Response(worker.stderr).text()
      try {
        expect(await waitForSpawnExit(worker, "acquisition worker", READER_READY_TIMEOUT_MS + 5000)).toBe(0)
        console.log((await stdout).trim())
        expect(await stderr).toBe("")
      } catch (error) {
        await stopSpawn(worker, "failed acquisition worker stop")
        console.error(
          `Windows ${boundary} worker failed: exitCode=${worker.exitCode}, signalCode=${worker.signalCode}\nstdout:\n${await stdout}\nstderr:\n${await stderr}`,
        )
        throw error
      } finally {
        await stopSpawn(worker, "owned worker stop")
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}
