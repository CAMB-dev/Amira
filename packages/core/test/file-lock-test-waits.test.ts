import { expect, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  waitForFileLockCondition,
  waitForFileLockWorkerExit,
  waitForFileLockWorkerReady,
} from "./file-lock-test-waits.ts"

test("file-lock event wait observes completion rather than an elapsed sleep", async () => {
  let checks = 0
  await waitForFileLockCondition("cleanup event", () => ++checks === 3)
  expect(checks).toBe(3)
})

test("file-lock event wait names the missing event and its bound", async () => {
  await expect(waitForFileLockCondition("lease unlink", () => false, 0)).rejects.toThrow(
    "lease unlink timed out after 0ms",
  )
})

test("file-lock worker startup does not consume the operation watchdog", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-lock-startup-"))
  const helper = pathToFileURL(path.join(import.meta.dir, "file-lock-test-waits.ts")).href
  const worker = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(import.meta.dir, "file-lock-worker-preload.ts"),
      "--eval",
      `await Bun.sleep(4500); const { fileLockWorkerReady } = await import(${JSON.stringify(helper)}); await fileLockWorkerReady(${JSON.stringify(dir)})`,
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
  try {
    await waitForFileLockWorkerReady(worker, dir, "slow startup fixture")
    expect(await waitForFileLockWorkerExit(worker, "post-ready operation", 2000)).toBe(0)
    expect(await new Response(worker.stderr).text()).toBe("")
    expect(fs.readdirSync(dir)).toEqual([])
  } finally {
    if (worker.exitCode === null) worker.kill()
    await waitForFileLockWorkerExit(worker, "startup fixture cleanup")
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 65_000)

test("file-lock worker exit wait names the phase and owned pid", async () => {
  const worker = {
    pid: 123,
    exitCode: null,
    exited: new Promise<number>(() => {}),
    stderr: undefined,
  }
  await expect(waitForFileLockWorkerExit(worker, "cleanup operation", 0)).rejects.toThrow(
    "cleanup operation exit timed out after 0ms (pid 123)",
  )
})
