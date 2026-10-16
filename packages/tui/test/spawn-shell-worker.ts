import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import {
  SPAWN_WAIT_TIMEOUT_MS,
  waitForSpawnCondition,
  waitForSpawnWork,
} from "../../../scripts/spawn-test.ts"
import { trackProcessTree } from "../../proc/src/process-tree.ts"
import type { ShellGuardRequest, ShellGuardResult } from "./spawn-shell-guard.ts"

// Assign the worker before it launches anything: assigning an already-running shell
// alone races its first child on Windows. Keep this handle until process exit so
// even an outer spawnSync timeout closes the job and kills every descendant.
if (process.platform === "win32") {
  const owner = trackProcessTree(
    {
      pid: process.pid,
      get exitCode() {
        return null
      },
      get signalCode() {
        return null
      },
      kill: () => process.kill(process.pid, "SIGKILL"),
    } as unknown as Bun.Subprocess,
    { killOnClose: true },
  )
  if (!owner.contained) throw new Error("Shell guard could not contain its worker")
}

const request = JSON.parse(
  process.argv[2] ? readFileSync(process.argv[2], "utf8") : await Bun.stdin.text(),
) as ShellGuardRequest
const { timeout = SPAWN_WAIT_TIMEOUT_MS, input, ...options } = request.options
// This is deliberately node's original async spawn, not Bun.spawn or a rewritten command.
const child = spawn(request.command, request.args, {
  ...options,
  detached: process.platform !== "win32",
  windowsHide: true,
})
const tree = trackProcessTree(child as unknown as Bun.Subprocess, { killOnClose: true })
child.stdin?.end(input)
const stdout: Buffer[] = []
const stderr: Buffer[] = []
child.stdout?.on("data", (data: Buffer) => stdout.push(Buffer.from(data)))
child.stderr?.on("data", (data: Buffer) => stderr.push(Buffer.from(data)))
let spawnError: NodeJS.ErrnoException | undefined
const exited = new Promise<void>((resolve) => {
  child.once("exit", () => resolve())
  child.once("error", (error: NodeJS.ErrnoException) => {
    spawnError = error
    resolve()
  })
})
const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
let cleanup: Promise<void> | undefined
function stopTree() {
  cleanup ??= (async () => {
    try {
      tree.kill()
      await waitForSpawnWork("shell guard cleanup", closed)
    } finally {
      tree.dispose()
    }
  })()
  return cleanup
}
const onSignal = () => {
  void stopTree().finally(() => process.exit(1))
}
process.once("SIGTERM", onSignal)
process.once("SIGINT", onSignal)

let error: ShellGuardResult["error"]
let timedOut = false
try {
  if (request.readyFile) {
    await waitForSpawnCondition("shell guard startup", () => existsSync(request.readyFile!))
  }
  try {
    await waitForSpawnWork(
      "shell operation",
      exited,
      Math.min(timeout || SPAWN_WAIT_TIMEOUT_MS, SPAWN_WAIT_TIMEOUT_MS),
    )
  } catch (cause) {
    timedOut = true
    error = { message: String(cause), code: "ETIMEDOUT" }
  }
} finally {
  // Also kill descendants after a successful shell exit; they must not escape a test.
  await stopTree()
  process.removeListener("SIGTERM", onSignal)
  process.removeListener("SIGINT", onSignal)
}
if (spawnError) error = { message: spawnError.message, code: spawnError.code }
const result: ShellGuardResult = {
  pid: child.pid ?? 0,
  status: timedOut ? null : child.exitCode,
  signal: child.signalCode,
  stdout: child.stdout ? Buffer.concat(stdout).toString("base64") : null,
  stderr: child.stderr ? Buffer.concat(stderr).toString("base64") : null,
  error,
}
writeFileSync(request.resultFile, JSON.stringify(result))
