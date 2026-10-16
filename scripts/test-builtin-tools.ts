import { spyOn } from "bun:test"
import builtinTools from "../extensions/builtin-tools/src/index.ts"
import * as shell from "../extensions/builtin-tools/src/shell.ts"
import type { Extension } from "../packages/api/src/index.ts"
import * as apiProcess from "../packages/api/src/index.ts"
import { waitForSpawnCondition } from "./spawn-test.ts"

/**
 * Tool-registration/UI tests do not exercise shell warmup. Keep their real builtin
 * registration, but do not leave fire-and-forget commands or PowerShell standbys
 * behind. Shell/process integration tests exercise the real warmup separately.
 */
export async function withoutBuiltinWarmup<T>(load: () => Promise<T>): Promise<T> {
  let shellWarmed = false
  let commandsWarmed = false
  const warmShell = spyOn(shell, "warmUpShell").mockImplementation(() => {
    shellWarmed = true
  })
  const warmCommands = spyOn(apiProcess, "hostWarmUpCommands").mockImplementation(() => {
    commandsWarmed = true
  })
  try {
    const result = await load()
    // The extension schedules this callback; observe it before restoring the spies.
    await waitForSpawnCondition("builtin warmup callback", () => shellWarmed && commandsWarmed)
    return result
  } finally {
    warmShell.mockRestore()
    warmCommands.mockRestore()
  }
}

export const builtinToolsWithoutWarmup: Extension = (api) =>
  withoutBuiltinWarmup(async () => builtinTools(api))
