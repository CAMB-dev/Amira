import { expect, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { waitForFileLockWorkerExit, waitForFileLockWorkerReady } from "./file-lock-test-waits.ts"

async function runWorker(kind: string, mode: string, fault = "EBUSY", retryDelay?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-file-cleanup-"))
  const worker = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(import.meta.dir, "file-lock-worker-preload.ts"),
      path.join(import.meta.dir, "file-lock-cleanup-worker.ts"),
      dir,
      kind,
      mode,
      fault,
      ...(retryDelay === undefined ? [] : [String(retryDelay)]),
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
    const label = `file cleanup ${kind}/${mode}/${fault}`
    await waitForFileLockWorkerReady(worker, dir, label)
    // The worker owns bounded 30s event waits; this is a deadlock guard, not a latency assertion.
    await waitForFileLockWorkerExit(worker, `${label} operation`, 35_000)
    expect(await new Response(worker.stderr).text()).toBe("")
    expect(worker.exitCode).toBe(0)
  } finally {
    if (worker.exitCode === null) worker.kill()
    await waitForFileLockWorkerExit(worker, "file cleanup teardown")
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
for (const fault of ["EPERM", "EBUSY", "EACCES"]) {
  for (const mode of ["direct", "prior-gate"])
    test(`lease unlink recovers ${fault} after ${mode}`, () => runWorker("lease", mode, fault), 100_000)
  for (const mode of ["fresh", "resumed"])
    test(
      `private unlink preserves ${mode} claim after ${fault}`,
      () => runWorker("private", mode, fault),
      100_000,
    )
}
for (const mode of ["fresh", "resumed"])
  test(
    `private unlink preserves ${mode} claim during held reader`,
    () => runWorker("private", mode, "held"),
    100_000,
  )
for (const kind of ["lease", "private"]) {
  for (const mode of [
    "release",
    "acquire",
    "exit-success",
    "exit-failure",
    "replacement",
    "tampered",
    "parent",
    "reentrant",
  ])
    test(`${kind} unlink retains bounded cleanup and ${mode} safety`, () => runWorker(kind, mode), 100_000)
}
for (const mode of ["eexist", "publish-error", "canonical-replacement"])
  test(`private cleanup preserves ${mode}`, () => runWorker("private", mode), 100_000)

test(
  "lease unlink waits for a delayed retry callback after prior-gate",
  () => runWorker("lease", "prior-gate", "EACCES", 500),
  100_000,
)
