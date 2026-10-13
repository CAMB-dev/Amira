import { expect, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"

const modes = ["claim", "release", "reclaim", ...(process.platform === "win32" ? ["windows-reader"] : [])]
for (const mode of modes) {
  test(`100ms gate reader keeps ${mode} zero-delay callback below 20ms`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-lock-latency-"))
    const worker = Bun.spawn(
      [
        process.execPath,
        "--preload",
        path.join(import.meta.dir, "file-lock-worker-preload.ts"),
        path.join(
          import.meta.dir,
          mode === "windows-reader" ? "file-lock-latency-reader-worker.ts" : "file-lock-latency-worker.ts",
        ),
        dir,
        mode,
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
    try {
      await Promise.race([
        worker.exited,
        Bun.sleep(4000).then(() => {
          throw new Error("latency worker timed out")
        }),
      ])
      console.log((await new Response(worker.stdout).text()).trim())
      expect(await new Response(worker.stderr).text()).toBe("")
      expect(worker.exitCode).toBe(0)
    } finally {
      if (worker.exitCode === null) worker.kill()
      await worker.exited
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 7000)
}
