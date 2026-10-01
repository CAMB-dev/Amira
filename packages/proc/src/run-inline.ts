import type { Subprocess } from "bun"
import { CMD_GATE_VAR, cmdArgv } from "./cmd-line.ts"
import { type ProcessTree, trackProcessTree } from "./process-tree.ts"

/** How long to wait for pipes to close after the command exits (and leftovers are killed). */
export const DRAIN_GRACE_MS = 2000

/** How to start a command; fixed once the process exists. */
export interface SpawnOptions {
  cwd: string
  env?: Record<string, string | undefined>
  /** The command waits for a line on stdin, which is sent once the process tree is contained. */
  gated?: boolean
  /**
   * Windows: start the program through cmd.exe. Bun stalls about 4 s on some spawns of MSYS and
   * Git programs, but not on cmd. When gated, cmd waits for the gate and only then starts the
   * program, which finds stdin at its end and AMIRA_GATE set. A program that may also be started
   * directly (a UNC working directory, a program that is not an .exe, other systems) should read
   * the gate line itself unless that variable is set. Cannot be combined with gateLine.
   */
  viaCmd?: boolean
  /** Keep stderr out of `output` (it is discarded). Default false: both streams are interleaved. */
  stdoutOnly?: boolean
  /** Test seam: how the process tree is tracked and killed. */
  trackTree?: (proc: Subprocess) => ProcessTree
}

/** How to let a started command run and collect it. */
export interface ReleaseOptions {
  /** The line that releases a gated command, without its newline (default empty). */
  gateLine?: string
  /** Counted from the release, not from the spawn. */
  timeoutMs: number
  signal: AbortSignal
  /** Called with each new piece of output, in order; output from before the release comes first. */
  onChunk?: (chunk: string) => void
}

export type RunOptions = SpawnOptions & ReleaseOptions

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

/** A prepared command can no longer run: it exited, was disposed, already ran, or never started. */
export class StandbyGoneError extends Error {
  override name = "StandbyGoneError"
}

/** A started, contained command that runs once released; see `prepareCommandInline`. */
export interface PreparedCommand {
  /** False once the process exited, was disposed or was released. */
  readonly alive: boolean
  /** Releases the gate and collects the command. Rejects with StandbyGoneError if it cannot run. */
  run(opts: ReleaseOptions): Promise<RunResult>
  /** Kills the process tree unless it was already released. */
  dispose(): void
}

/**
 * Runs argv on the current thread, killing the whole process tree on abort, timeout and exit.
 * Spawning can block this thread for seconds on some Windows machines; frontends should use
 * `runCommand`, which runs this in a worker.
 */
export function runCommandInline(argv: string[], opts: RunOptions): Promise<RunResult> {
  if (opts.viaCmd && opts.gateLine !== undefined) {
    return Promise.reject(new Error("gateLine cannot be combined with viaCmd"))
  }
  let prepared: PreparedCommand
  try {
    prepared = prepareCommandInline(argv, opts)
  } catch (err) {
    return Promise.reject(err)
  }
  return prepared.run(opts)
}

/**
 * Spawns argv and contains its tree now; `run` releases it later. A gated command does nothing
 * until then, so the process start (slow on Windows) can be paid ahead of time. Output before
 * the release is kept. `onIdleExit` is called if the process exits before it is released.
 */
export function prepareCommandInline(
  argv: string[],
  opts: SpawnOptions,
  onIdleExit?: () => void,
): PreparedCommand {
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

  let output = ""
  let onChunk: ((chunk: string) => void) | undefined
  let finished = false
  const emit = (chunk: string) => {
    output += chunk
    if (chunk) onChunk?.(chunk)
  }
  const readers: { cancel(): Promise<void> }[] = []
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    readers.push(reader)
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done || finished) break
      emit(decoder.decode(value, { stream: true }))
    }
    if (!finished) emit(decoder.decode())
  }
  const streams = opts.stdoutOnly ? [proc.stdout] : [proc.stdout, proc.stderr as ReadableStream<Uint8Array>]
  const drained = Promise.all(streams.map(pump)).catch(() => {})

  let state: "idle" | "released" | "closed" = "idle"
  const exited = () => proc.exitCode !== null || proc.signalCode !== null
  // Nothing reaches `output` or onChunk after this point, even if a pipe holder survived.
  const close = () => {
    finished = true
    for (const r of readers) r.cancel().catch(() => {})
    tree.dispose()
  }
  const closeIdle = () => {
    if (state !== "idle") return false
    state = "closed"
    tree.kill()
    close()
    return true
  }
  proc.exited.then(
    () => closeIdle() && onIdleExit?.(),
    () => {},
  )

  return {
    get alive() {
      return state === "idle" && !exited()
    },
    async run(release) {
      if (state !== "idle" || exited()) {
        closeIdle()
        throw new StandbyGoneError("the prepared command is no longer available")
      }
      if (wrapped && release.gateLine !== undefined)
        throw new Error("gateLine cannot be combined with viaCmd")
      state = "released"
      onChunk = release.onChunk
      if (output) onChunk?.(output)
      // cmd's `set /p` fails on an empty line, which would end the command with 125.
      if (gated) releaseGate(proc.stdin, wrapped ? "go" : (release.gateLine ?? ""))
      return collect(proc, tree, drained, release, () => output, close)
    },
    dispose() {
      closeIdle()
    },
  }
}

async function collect(
  proc: Subprocess,
  tree: ProcessTree,
  drained: Promise<unknown>,
  opts: ReleaseOptions,
  output: () => string,
  close: () => void,
): Promise<RunResult> {
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
      output: output(),
      exitCode,
      signalCode: proc.signalCode,
      timedOut: cause === "timeout",
      aborted: cause === "abort",
      settled,
      contained: tree.contained,
    }
  } finally {
    clearTimeout(timer)
    clearTimeout(graceTimer)
    endGrace()
    opts.signal.removeEventListener("abort", onAbort)
    close()
  }
}

/** An inherited gate variable would let a directly started program skip its gate. */
export function withoutGateVar(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...env }
  for (const k of Object.keys(out)) if (k.toUpperCase() === CMD_GATE_VAR) delete out[k]
  return out
}

export function releaseGate(stdin: Bun.FileSink | undefined, line: string): void {
  if (!stdin) return
  try {
    stdin.write(`${line}\n`)
    Promise.resolve(stdin.end()).catch(() => {})
  } catch {}
}
