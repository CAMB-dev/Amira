import { runCommand } from "@amira/proc"
import { PackageError } from "./manifest.ts"

/** Git fetches, npm downloads and dependency installs may be slow, but not endless. */
export const COMMAND_TIMEOUT_MS = 5 * 60 * 1000

export interface RunToolOptions {
  signal?: AbortSignal
  /** Keep stderr out of the result (it is discarded). */
  stdoutOnly?: boolean
  env?: Record<string, string>
  /** Each piece of output as it arrives (progress parsing). */
  onChunk?: (chunk: string) => void
  timeoutMs?: number
}

/**
 * Variables that would point git at another repository, work tree or index than the one a
 * command names (they are set inside git hooks, for example).
 */
const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
]

/** Runs a program to completion; a failure, timeout or cancel is a PackageError naming `what`. */
export async function runTool(
  argv: string[],
  cwd: string,
  what: string,
  opts: RunToolOptions = {},
): Promise<string> {
  const env: Record<string, string | undefined> = { ...process.env }
  if (argv[0] === "git")
    for (const k of Object.keys(env)) if (GIT_LOCATION_VARS.includes(k.toUpperCase())) delete env[k]
  const r = await runCommand(argv, {
    cwd,
    timeoutMs: opts.timeoutMs ?? COMMAND_TIMEOUT_MS,
    signal: opts.signal ?? new AbortController().signal,
    // Never wait for a credential prompt nobody can see.
    env: { ...env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
    ...(opts.stdoutOnly ? { stdoutOnly: true } : {}),
    ...(opts.onChunk ? { onChunk: opts.onChunk } : {}),
    // Windows: Bun stalls for seconds on some direct spawns of git.
    ...(argv[0] === "git" ? { viaCmd: true } : {}),
  })
  if (r.exitCode === 0) return r.output
  const why = r.timedOut
    ? "timed out"
    : r.aborted
      ? "was cancelled"
      : `failed (exit ${r.exitCode ?? r.signalCode})`
  const output = lastLines(r.output, 8)
  throw new ToolError(`${what} ${why}${output ? `:\n${output}` : ""}`, r.aborted, output)
}

/** A failed command; `output` is its last lines, `aborted` whether it was cancelled. */
export class ToolError extends PackageError {
  constructor(
    message: string,
    readonly aborted: boolean,
    readonly output: string,
  ) {
    super(message)
  }
}

/** The last lines of a command's output, without progress lines that were overwritten by `\r`. */
export function lastLines(output: string, n: number): string {
  return output
    .split(/\r?\n/)
    .map((l) => l.slice(l.lastIndexOf("\r") + 1))
    .filter((l) => l.trim())
    .slice(-n)
    .join("\n")
    .trim()
}
