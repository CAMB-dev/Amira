import type { Subprocess } from "bun"
import { CMD_GATE_VAR, cmdArgv } from "./cmd-line.ts"
import { type ProcessTree, trackProcessTree } from "./process-tree.ts"

/** How long to wait for pipes to close after the command exits (and leftovers are killed). */
export const DRAIN_GRACE_MS = 2000

export interface RunOptions {
  cwd: string
  env?: Record<string, string | undefined>
  /** The command waits for a line on stdin, which is sent once the process tree is contained. */
  gated?: boolean
  /** The line that releases a gated command, without its newline (default empty). */
  gateLine?: string
  /**
   * Windows: start the program through cmd.exe. Bun stalls about 4 s on some spawns of MSYS and
   * Git programs, but not on cmd. When gated, cmd waits for the gate and only then starts the
   * program, which finds stdin at its end and AMIRA_GATE set. A program that may also be started
   * directly (a UNC working directory, a program that is not an .exe, other systems) should read
   * the gate line itself unless that variable is set. Cannot be combined with gateLine.
   */
  viaCmd?: boolean
  timeoutMs: number
  signal: AbortSignal
  /** Called with each new piece of output, in order. */
  onChunk?: (chunk: string) => void
  /** Keep stderr out of `output` (it is discarded). Default false: both streams are interleaved. */
  stdoutOnly?: boolean
  /** Test seam: how the process tree is tracked and killed. */
  trackTree?: (proc: Subprocess) => ProcessTree
}

export interface RunResult {
  output: string
  exitCode: number | null
  signalCode: string | null
  /** Set only when the timeout fired before the process exited. */
  timedOut: boolean
  aborted: boolean
  /** False when the pipes were still open after the drain grace, i.e. something kept running. */
  settled: boolean
  /** False when the process tree could not be contained, so kills may have missed processes. */
  contained: boolean
}

/**
 * Runs argv on the current thread, killing the whole process tree on abort, timeout and exit.
 * Spawning can block this thread for seconds on some Windows machines; frontends should use
 * `runCommand`, which runs this in a worker.
 */
export async function runCommandInline(argv: string[], opts: RunOptions): Promise<RunResult> {
  if (opts.viaCmd && opts.gateLine !== undefined) throw new Error("gateLine cannot be combined with viaCmd")
  const gated = !!opts.gated
  const env = withoutGateVar(opts.env ?? process.env)
  const wrapped =
    opts.viaCmd && process.platform === "win32" ? cmdArgv(argv, { cwd: opts.cwd, env, gated }) : undefined
  const proc = Bun.spawn(wrapped ?? argv, {
    cwd: opts.cwd,
    env,
    stdin: gated ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: opts.stdoutOnly ? "ignore" : "pipe",
    windowsHide: true,
    // cmdArgv built the whole cmd line; Bun must not quote it again.
    windowsVerbatimArguments: !!wrapped,
    // POSIX: new session, so the whole process group can be killed.
    detached: process.platform !== "win32",
  })
  let tree: ProcessTree
  try {
    tree = (opts.trackTree ?? trackProcessTree)(proc)
  } catch (err) {
    // A gated command would wait on stdin forever; nothing may keep running unaccounted for.
    proc.kill()
    throw err
  }
  // cmd's `set /p` fails on an empty line, which would end the command with 125.
  if (gated) releaseGate(proc.stdin, wrapped ? "go" : (opts.gateLine ?? ""))

  let output = ""
  let finished = false
  const readers: { cancel(): Promise<void> }[] = []
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    readers.push(reader)
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done || finished) break
      const chunk = decoder.decode(value, { stream: true })
      output += chunk
      if (chunk) opts.onChunk?.(chunk)
    }
    if (!finished) {
      const tail = decoder.decode()
      output += tail
      if (tail) opts.onChunk?.(tail)
    }
  }
  const streams = opts.stdoutOnly ? [proc.stdout] : [proc.stdout, proc.stderr as ReadableStream<Uint8Array>]
  const drained = Promise.all(streams.map(pump)).catch(() => {})

  let reason: "timeout" | "abort" | undefined
  const stop = (why: "timeout" | "abort") => {
    reason ??= why
    tree.kill()
  }
  const timer = setTimeout(() => stop("timeout"), opts.timeoutMs)
  const onAbort = () => stop("abort")
  opts.signal.addEventListener("abort", onAbort, { once: true })
  if (opts.signal.aborted) onAbort()

  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let endGrace = () => {}
  try {
    const exitCode = await proc.exited
    clearTimeout(timer)
    opts.signal.removeEventListener("abort", onAbort)
    // Only a timeout or abort that fired before the exit explains how the command ended.
    const cause = reason
    // Kill background leftovers too; they would otherwise keep the pipes open and outlive the call.
    tree.kill()
    // An abort cuts the grace short.
    const grace = new Promise<boolean>((resolve) => {
      const give = () => resolve(false)
      graceTimer = setTimeout(give, DRAIN_GRACE_MS)
      opts.signal.addEventListener("abort", give, { once: true })
      endGrace = () => opts.signal.removeEventListener("abort", give)
      if (opts.signal.aborted) give()
    })
    const settled = await Promise.race([drained.then(() => true), grace])
    return {
      output,
      exitCode,
      signalCode: proc.signalCode,
      timedOut: cause === "timeout",
      aborted: cause === "abort",
      settled,
      contained: tree.contained,
    }
  } finally {
    // Nothing reaches `output` or onChunk after this point, even if a pipe holder survived.
    finished = true
    clearTimeout(timer)
    clearTimeout(graceTimer)
    endGrace()
    opts.signal.removeEventListener("abort", onAbort)
    for (const r of readers) r.cancel().catch(() => {})
    tree.dispose()
  }
}

/** An inherited gate variable would let a directly started program skip its gate. */
function withoutGateVar(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...env }
  for (const k of Object.keys(out)) if (k.toUpperCase() === CMD_GATE_VAR) delete out[k]
  return out
}

function releaseGate(stdin: Bun.FileSink | undefined, line: string): void {
  if (!stdin) return
  try {
    stdin.write(`${line}\n`)
    Promise.resolve(stdin.end()).catch(() => {})
  } catch {}
}
