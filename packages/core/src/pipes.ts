import type { OpenPipeOptions, PipeEvent, PipeProcess } from "@amira/api"
import { openPipe } from "@amira/proc"

/**
 * Processes extensions started with ExtensionAPI.openPipe that have not exited yet, from spawn
 * until exit, so one still inside its close grace period is covered too.
 */
const livePids = new Set<number>()
let exitHookInstalled = false

/**
 * Kills the trees of extension processes still running when Amira exits. Workers are gone by
 * then, so this spawns on the main thread (without pipes, see `openPipe`): taskkill /T,
 * because killing only a launcher (cmd.exe, a .cmd shim) leaves the real process running on
 * Windows.
 */
export function killExtensionPipes(): void {
  if (!livePids.size) return
  const pids = [...livePids]
  livePids.clear()
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/T", "/F", ...pids.flatMap((p) => ["/PID", String(p)])], {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
    } catch {}
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

/** ExtensionAPI.openPipe: a piped process in the command worker, killed when Amira exits. */
export function openExtensionPipe(argv: string[], options: OpenPipeOptions): PipeProcess {
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== "string")) {
    throw new Error("openPipe needs a command: a non-empty list of strings")
  }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(options.env ?? process.env)) if (typeof v === "string") env[k] = v
  let pid: number | undefined
  const deliver = (e: PipeEvent) => {
    try {
      options.onEvent(e)
    } catch {
      // A failing callback must not break delivery of the rest.
    }
  }
  return openPipe({ argv, cwd: options.cwd, env }, (e) => {
    if (e.type === "spawned") {
      pid = e.pid
      livePids.add(e.pid)
      if (!exitHookInstalled) {
        exitHookInstalled = true
        process.once("exit", killExtensionPipes)
      }
    } else if (e.type === "exit" && pid !== undefined && !e.error) {
      // Without an error the process really exited; a lost worker may have left it running.
      livePids.delete(pid)
    }
    deliver(e)
  })
}
