import type { RunCommandOptions, RunCommandResult } from "./process.ts"

/**
 * What a package's command (`"commands": {"<name>": "./cli.ts"}` in its manifest) gets when
 * the user runs `amira <name> ...`. Such a command runs instead of a session, e.g. to serve
 * Amira over another protocol; it can start Amira again through `amiraArgv`.
 */
export interface PackageCommandContext {
  readonly apiVersion: string
  /** The arguments after the command name. */
  readonly argv: string[]
  readonly cwd: string
  /** Amira's per-user directory: `$AMIRA_HOME`, or `~/.amira`. */
  readonly home: string
  /** The command line that starts this same Amira, e.g. `["amira"]`; append flags such as `-p`. */
  readonly amiraArgv: string[]
  /** Runs a command off the main thread, killing its whole process tree on abort and timeout. */
  runCommand(argv: string[], options: RunCommandOptions): Promise<RunCommandResult>
  readonly stdin: ReadableStream<Uint8Array>
  stdout(text: string): void
  stderr(text: string): void
}

/** The default export of a package command module; resolves to the exit code. */
export type PackageCommand = (ctx: PackageCommandContext) => number | Promise<number>

export function definePackageCommand(command: PackageCommand): PackageCommand {
  return command
}
