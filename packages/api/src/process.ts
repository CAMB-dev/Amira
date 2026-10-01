export interface RunCommandOptions {
  cwd: string
  env?: Record<string, string | undefined>
  /** Milliseconds before the command and everything it started are killed. */
  timeoutMs: number
  signal: AbortSignal
  /** Called with each new piece of output, in order, while the command runs. */
  onChunk?: (chunk: string) => void
  /**
   * Keep only the last this many characters in the result's `output`, so a chatty command cannot
   * fill memory; onChunk still sees everything. Default: all of it.
   */
  maxOutputChars?: number
  /** Keep stderr out of the output (it is discarded). Default: both are interleaved. */
  stdoutOnly?: boolean
  /**
   * The command must wait for one line on stdin before doing anything; the host sends it
   * once the process tree is contained, so nothing it starts can escape a kill.
   */
  gated?: boolean
  /**
   * Text for the command's stdin, e.g. JSON describing what a hook runs for. It is written once
   * the process tree is contained, followed by a newline (unless it ends with one), and then
   * stdin is closed. Without it the command gets no stdin (or only the gate line). Cannot be
   * combined with `gated` or `viaCmd`.
   */
  stdin?: string
  /** Windows: start through cmd.exe, which avoids the long spawn stalls some machines have with git. */
  viaCmd?: boolean
}

export interface RunCommandResult {
  output: string
  exitCode: number | null
  signalCode: string | null
  /** The timeout fired before the command exited. */
  timedOut: boolean
  aborted: boolean
  /** False when output pipes stayed open after the command ended, i.e. something kept running. */
  settled: boolean
  /** False when the process tree could not be contained, so kills may have missed processes. */
  contained: boolean
}

/** What a process started with ExtensionAPI.openPipe reports, in order. */
export type PipeEvent =
  | { type: "spawned"; pid: number }
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  /**
   * The last event. `error`: the process failed to start (then no "spawned" came before), or
   * the host lost track of it (it may still run).
   */
  | { type: "exit"; code: number | null; error?: string }

export interface OpenPipeOptions {
  cwd: string
  /** The whole environment of the process. Default: Amira's own. */
  env?: Record<string, string | undefined>
  /** Called with each event; a throw is ignored and does not stop later events. */
  onEvent(event: PipeEvent): void
}

/** A long-lived process with piped stdio, e.g. a language server (ExtensionAPI.openPipe). */
export interface PipeProcess {
  /** Writes to its stdin; ignored once it has exited. Writes before "spawned" are kept for it. */
  write(data: string): void
  /** Ends its stdin, then kills its process tree if it has not exited after `graceMs`. */
  close(graceMs: number): void
}
