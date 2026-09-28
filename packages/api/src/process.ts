export interface RunCommandOptions {
  cwd: string
  env?: Record<string, string | undefined>
  /** Milliseconds before the command and everything it started are killed. */
  timeoutMs: number
  signal: AbortSignal
  /** Called with each new piece of output, in order. */
  onChunk?: (chunk: string) => void
  /** Keep stderr out of the output (it is discarded). Default: both are interleaved. */
  stdoutOnly?: boolean
  /**
   * The command must wait for one line on stdin before doing anything; the host sends it
   * once the process tree is contained, so nothing it starts can escape a kill.
   */
  gated?: boolean
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
