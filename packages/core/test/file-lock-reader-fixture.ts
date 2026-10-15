import * as fs from "node:fs"
import path from "node:path"

// Loaded Windows runners may spend several seconds starting PowerShell/antivirus.
// Setup is outside every measured lock interval; post-readiness budgets stay separate.
export const READER_READY_TIMEOUT_MS = 15000

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
  $deadline = [DateTime]::UtcNow.AddSeconds(3)
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
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  const stderr = new Response(reader.stderr).text()
  const waitUntilReady = async () => {
    const deadline = performance.now() + READER_READY_TIMEOUT_MS
    while (!fs.existsSync(ready)) {
      if (reader.exitCode !== null || performance.now() > deadline) {
        const reason = reader.exitCode === null ? "timed out" : "exited"
        if (reader.exitCode === null) reader.kill()
        await boundedExit(reader, "failed reader stop")
        throw new Error(
          `reader readiness ${reason}: exitCode=${reader.exitCode}, signalCode=${reader.signalCode}\nstderr:\n${await stderr}`,
        )
      }
      await Bun.sleep(2)
    }
  }
  return { reader, ready, go, stderr, waitUntilReady }
}

export async function boundedExit(reader: Bun.Subprocess, label: string, ms = 2000): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exit timed out`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
