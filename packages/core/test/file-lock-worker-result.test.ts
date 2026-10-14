import { expect, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"

for (const held of [true, false]) {
  test(`worker publishes a complete ${held ? "successful" : "failed"} claim result atomically`, async () => {
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
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
        ),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      },
    )
    async function waitFor(marker: string) {
      const deadline = Date.now() + 4000
      while (!fs.existsSync(path.join(dir, marker))) {
        if (worker.exitCode !== null)
          throw new Error(`result worker exited: ${await new Response(worker.stderr).text()}`)
        if (Date.now() > deadline) throw new Error(`result worker timed out: ${marker}`)
        await Bun.sleep(10)
      }
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
      expect(await worker.exited).toBe(0)
      expect(await new Response(worker.stderr).text()).toBe("")
    } finally {
      if (worker.exitCode === null) worker.kill()
      await worker.exited
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
