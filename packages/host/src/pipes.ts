import type { OpenPipeOptions, PipeProcess } from "@amira/api"
import { openPipe } from "@amira/proc"

/**
 * ExtensionAPI.openPipe: a piped process in the command worker. @amira/proc kills its tree
 * when Amira exits if it is still running then.
 */
export function openExtensionPipe(argv: string[], options: OpenPipeOptions): PipeProcess {
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== "string")) {
    throw new Error("openPipe needs a command: a non-empty list of strings")
  }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(options.env ?? process.env)) if (typeof v === "string") env[k] = v
  return openPipe({ argv, cwd: options.cwd, env }, (e) => {
    try {
      options.onEvent(e)
    } catch {
      // A failing callback must not break delivery of the rest.
    }
  })
}
