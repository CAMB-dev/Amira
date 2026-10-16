import { spyOn } from "bun:test"
import * as childProcess from "node:child_process"
import { SPAWN_WAIT_TIMEOUT_MS, waitForSpawnWork as waitForWork } from "../../../scripts/spawn-test.ts"
import { guardedSpawnSync } from "./spawn-shell-guard.ts"

/** Keep production editor selection and shell launches real, but never wait forever. */
export function boundSpawnSync() {
  const spawnSync = childProcess.spawnSync
  return spyOn(childProcess, "spawnSync").mockImplementation(((
    command: string,
    argsOrOptions?: readonly string[] | childProcess.SpawnSyncOptions,
    options?: childProcess.SpawnSyncOptions,
  ) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : []
    const opts = Array.isArray(argsOrOptions)
      ? options
      : (argsOrOptions as childProcess.SpawnSyncOptions | undefined)
    const bounded = {
      ...opts,
      timeout: Math.min(opts?.timeout || SPAWN_WAIT_TIMEOUT_MS, SPAWN_WAIT_TIMEOUT_MS),
    }
    return opts?.shell ? guardedSpawnSync(command, args, bounded) : spawnSync(command, args, bounded)
  }) as typeof childProcess.spawnSync)
}

/** App sessions and command workers expose promises, not Bun.Subprocess handles. */
export async function waitForSpawnWork<T>(
  work: Promise<T>,
  label: string,
  timeoutMs = SPAWN_WAIT_TIMEOUT_MS,
): Promise<T> {
  return waitForWork(label, work, timeoutMs)
}
