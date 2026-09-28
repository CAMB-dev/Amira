import type { Subprocess } from "bun"
import { type ProcessTree, trackProcessTree } from "./process-tree.ts"

/** How long to wait for pipes to close after the command exits (and leftovers are killed). */
export const DRAIN_GRACE_MS = 2000

export interface RunOptions {
  cwd: string
  env?: Record<string, string | undefined>
  /** The command waits for a line on stdin, which is sent once the process tree is contained. */
  gated?: boolean
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
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdin: opts.gated ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: opts.stdoutOnly ? "ignore" : "pipe",
    windowsHide: true,
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
  if (opts.gated) releaseGate(proc.stdin)

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

function releaseGate(stdin: Bun.FileSink | undefined): void {
  if (!stdin) return
  try {
    stdin.write("\n")
    Promise.resolve(stdin.end()).catch(() => {})
  } catch {}
}
