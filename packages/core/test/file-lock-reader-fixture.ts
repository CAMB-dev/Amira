import * as fs from "node:fs"
import path from "node:path"
import { waitForFileLockWorkerExit } from "./file-lock-test-waits.ts"

// Antivirus can stall a Windows spawn for 4-10s, especially under parallel load.
// These setup/IPC deadlines only protect against hangs; the 100ms hold starts at go.
export const READER_READY_TIMEOUT_MS = 30000

/** Windows read-sharing without delete-sharing, with bounded ready/go IPC. No FFI. */
export function startGateReader(metadata: string, dir: string) {
  if (process.platform !== "win32") throw new Error("Windows reader required")
  const ready = path.join(dir, "reader-ready")
  const go = path.join(dir, "reader-go")
  const reader = Bun.spawn(
    [
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'
$stream = [IO.File]::Open($env:LOCK_READER_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  [IO.File]::WriteAllText($env:LOCK_READER_READY, 'ready')
  $deadline = [DateTime]::UtcNow.AddMilliseconds([double]$env:LOCK_READER_GO_TIMEOUT_MS)
  while (-not [IO.File]::Exists($env:LOCK_READER_GO)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'reader go timed out' }
    [Threading.Thread]::Sleep(2)
  }
  [Threading.Thread]::Sleep(100)
} finally { $stream.Dispose() }`,
    ],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
        ),
        LOCK_READER_FILE: metadata,
        LOCK_READER_READY: ready,
        LOCK_READER_GO: go,
        LOCK_READER_GO_TIMEOUT_MS: String(READER_READY_TIMEOUT_MS),
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  const stderr = new Response(reader.stderr).text()
  const waitUntilReady = async () => {
    const deadline = performance.now() + READER_READY_TIMEOUT_MS
    while (true) {
      if (reader.exitCode !== null || performance.now() > deadline) {
        const reason = reader.exitCode === null ? "timed out" : "exited"
        if (reader.exitCode === null) reader.kill()
        await boundedExit(reader, "failed reader stop")
        throw new Error(
          `reader readiness ${reason}: exitCode=${reader.exitCode}, signalCode=${reader.signalCode}\nstderr:\n${await stderr}`,
        )
      }
      if (fs.existsSync(ready)) return
      await Bun.sleep(2)
    }
  }
  return { reader, ready, go, stderr, waitUntilReady }
}

export async function boundedExit(reader: Bun.Subprocess, label: string, ms = 30000): Promise<number> {
  return waitForFileLockWorkerExit(reader, label, ms)
}
