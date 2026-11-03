import path from "node:path"

/** How this process was entered: the script Bun ran, and the arguments that select the server. */
export interface ServerLaunch {
  script: string
  subcommand: readonly string[]
}

/**
 * The command a daemon is relaunched with; spawn appends `daemon --cwd <workspace>`. A compiled
 * executable is relaunched by itself, a source run as `bun <script>`. The standalone server needs
 * no subcommand, the CLI needs `server`.
 */
export function daemonCommand(execPath: string, launch: ServerLaunch): string[] {
  const interpreter = /^bun(?:\.exe)?$/i.test(path.basename(execPath))
  return [...(interpreter ? [execPath, launch.script] : [execPath]), ...launch.subcommand]
}
