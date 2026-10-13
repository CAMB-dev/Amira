import { expect, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"

async function runWorker(script: string, ...args: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-gate-retirement-"))
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
  try {
    await Promise.race([
      worker.exited,
      Bun.sleep(4000).then(() => {
        throw new Error("retirement worker timed out")
      }),
    ])
    expect(await new Response(worker.stderr).text()).toBe("")
    expect(worker.exitCode).toBe(0)
  } finally {
    if (worker.exitCode === null) worker.kill()
    await Promise.race([
      worker.exited,
      Bun.sleep(2000).then(() => {
        throw new Error("retirement worker failed to exit")
      }),
    ])
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
for (const phase of ["claim", "release"]) {
  for (const fault of ["EPERM", "EBUSY", "EACCES", "held", "pending", "permanent"]) {
    test(
      `SessionStore ${phase} gate retirement survives ${fault}`,
      () => runWorker("file-lock-retirement-worker.ts", phase, fault),
      7000,
    )
  }
}
for (const mode of ["release", "acquire", "exit-success", "exit-failure"]) {
  test(
    `pending lease release stops automatic retries and retries on next ${mode}`,
    () => runWorker("file-lock-retirement-lease-worker.ts", mode),
    7000,
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
    () => runWorker("file-lock-retirement-safety-worker.ts", mode),
    7000,
  )
}
