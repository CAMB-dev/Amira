import { expect, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { aliasedDirectory } from "./file-lock-fixtures.ts"
import { waitForFileLockWorkerExit, waitForFileLockWorkerReady } from "./file-lock-test-waits.ts"

async function runWorker(script: string, args: string[], aliased = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amira-gate-retirement-"))
  const dir = aliased ? aliasedDirectory(root) : root
  const worker = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(import.meta.dir, "file-lock-worker-preload.ts"),
      path.join(import.meta.dir, script),
      dir,
      ...args,
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
  const label = `retirement ${script} ${args.join(" ")}`
  try {
    // Spawn/import stalls do not consume the operation's diagnostic bound. These
    // workers assert cleanup behavior, not latency (normal performs 120 lease turns).
    await waitForFileLockWorkerReady(worker, dir, label)
    await waitForFileLockWorkerExit(worker, label)
    expect(await new Response(worker.stderr).text()).toBe("")
    expect(worker.exitCode).toBe(0)
  } finally {
    if (worker.exitCode === null) worker.kill()
    await waitForFileLockWorkerExit(worker, `${label} cleanup`)
    fs.rmSync(root, { recursive: true, force: true })
  }
}
for (const [script, mode] of [
  ["file-lock-retirement-safety-worker.ts", "closure"],
  ["file-lock-retirement-lease-worker.ts", "exit-failure"],
]) {
  test(
    `aliased parent preserves ${script} ${mode} fault injection`,
    () => runWorker(script!, [mode!], true),
    95_000,
  )
}
for (const phase of ["claim", "release"]) {
  for (const fault of ["EPERM", "EBUSY", "EACCES", "held", "pending", "permanent"]) {
    test(
      `SessionStore ${phase} gate retirement survives ${fault}`,
      () => runWorker("file-lock-retirement-worker.ts", [phase, fault]),
      95_000,
    )
  }
}
for (const mode of ["release", "acquire", "exit-success", "exit-failure"]) {
  test(
    `pending lease release stops automatic retries and retries on next ${mode}`,
    () => runWorker("file-lock-retirement-lease-worker.ts", [mode]),
    95_000,
  )
}
for (const mode of [
  "normal",
  "active",
  "reentrant",
  "closure",
  "alias",
  "replacement",
  "parent",
  "private",
  "tampered",
  "exit-success",
  "exit-failure",
]) {
  test(
    `owned gate retirement preserves ${mode} safety`,
    () => runWorker("file-lock-retirement-safety-worker.ts", [mode]),
    95_000,
  )
}
