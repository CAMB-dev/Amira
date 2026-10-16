import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { SPAWN_TEST_TIMEOUT_MS } from "../../../scripts/spawn-test.ts"

export interface ShellGuardRequest {
  command: string
  args: readonly string[]
  options: SpawnSyncOptions
  resultFile: string
  /** Regression rendezvous: startup has its own budget, separate from the operation. */
  readyFile?: string
}

export interface ShellGuardResult {
  pid: number
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string | null
  stderr: string | null
  error?: { message: string; code?: string }
}

export const shellGuardWorker = fileURLToPath(new URL("./spawn-shell-worker.ts", import.meta.url))
const spawnGuard = spawnSync

/** Only the guard is shell-free: the worker runs the original command, arguments and shell options. */
export function guardedSpawnSync(command: string, args: readonly string[], options: SpawnSyncOptions) {
  const dir = mkdtempSync(join(tmpdir(), "amira-shell-guard-"))
  try {
    const resultFile = join(dir, "result.json")
    const request: ShellGuardRequest = { command, args, options, resultFile }
    const requestFile = join(dir, "request.json")
    writeFileSync(requestFile, JSON.stringify(request))
    const guard = spawnGuard(process.execPath, [shellGuardWorker, requestFile], {
      shell: false,
      windowsHide: true,
      timeout: SPAWN_TEST_TIMEOUT_MS,
      // SIGTERM lets the POSIX worker kill and reap its detached shell group.
      killSignal: "SIGTERM",
      // Preserve the real descriptors when the editor asks for stdio: "inherit".
      stdio: "inherit",
    })
    if (guard.error) throw guard.error
    if (guard.status !== 0) throw new Error(`Shell guard exited with ${guard.status ?? guard.signal}`)
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as ShellGuardResult
    const decode = (value: string | null) => {
      if (value === null) return null
      const buffer = Buffer.from(value, "base64")
      return options.encoding && options.encoding !== "buffer" ? buffer.toString(options.encoding) : buffer
    }
    const stdout = decode(result.stdout)
    const stderr = decode(result.stderr)
    return {
      pid: result.pid,
      status: result.status,
      signal: result.signal,
      stdout,
      stderr,
      output: [null, stdout, stderr],
      ...(result.error ? { error: Object.assign(new Error(result.error.message), result.error) } : {}),
    } as SpawnSyncReturns<string | Buffer>
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
