// A background job: a command that keeps running after the call that started it, still owned
// by Amira. Runs in the command worker, next to every other spawn with pipes (see `openPipe`
// in index.ts), or on the calling thread when workers are unavailable.
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { cmdArgv } from "./cmd-line.ts"
import { type ProcessTree, trackProcessTree } from "./process-tree.ts"
import { releaseGate, withoutGateVar } from "./run-inline.ts"

/** How long output may still arrive after the job's main process exited. */
export const JOB_DRAIN_MS = 1000

export interface JobSpec {
  argv: string[]
  cwd: string
  env?: Record<string, string | undefined>
  /** The command waits for a line on stdin, sent once its process tree is contained. */
  gated?: boolean
  /** The line that releases a gated command, without its newline (default empty). */
  gateLine?: string
  /** Windows: start the program through cmd.exe (see SpawnOptions.viaCmd). */
  viaCmd?: boolean
  /** All output is also written to this file (its directory is created), up to `maxLogBytes`. */
  logPath?: string
  /** See DEFAULT_MAX_LOG_BYTES; the log then says it stopped there. */
  maxLogBytes?: number
}

// Asserted equal to the central settings default by scripts/settings-docs.test.ts.
export const DEFAULT_MAX_LOG_BYTES = 50 * 1024 * 1024

/** What a job reports, in order: "spawned" (unless it cannot start), output, then one "exit". */
export type JobEvent =
  /** `jobHandle`: the Windows Job Object holding it (see ProcessTree.jobHandle). */
  | { type: "spawned"; pid: number; contained: boolean; jobHandle?: number }
  /** stdout and stderr, interleaved as they arrive. */
  | { type: "output"; data: string }
  /**
   * The last event. `error`: the job could not start, or the worker running it was lost (its
   * processes may still run). `logError`: the log file could not be written.
   */
  | { type: "exit"; code: number | null; signal: string | null; error?: string; logError?: string }

export interface JobHandle {
  /**
   * Stops the whole tree: asks it to stop where the platform can (SIGTERM to the process group
   * on POSIX) and kills it after `graceMs`; kills at once on Windows or with `graceMs` 0.
   */
  stop(graceMs: number): void
}

/** Starts a job on this thread. Frontends use `startJob`, which runs it in the command worker. */
export function startJobInline(spec: JobSpec, emit: (e: JobEvent) => void): JobHandle {
  const gated = !!spec.gated
  const env = withoutGateVar(spec.env ?? process.env)
  const wrapped =
    spec.viaCmd && process.platform === "win32"
      ? cmdArgv(spec.argv, { cwd: spec.cwd, env, gated })
      : undefined
  let proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">
  let tree: ProcessTree
  try {
    proc = Bun.spawn(wrapped ?? spec.argv, {
      cwd: spec.cwd,
      env,
      stdin: gated ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      windowsVerbatimArguments: !!wrapped,
      // POSIX: a new session, so the whole process group can be signalled.
      detached: process.platform !== "win32",
    })
  } catch (err) {
    emit({ type: "exit", code: null, signal: null, error: message(err) })
    return { stop() {} }
  }
  try {
    tree = trackProcessTree(proc, { killOnClose: true })
  } catch (err) {
    // A gated command would wait forever; nothing may run unaccounted for.
    proc.kill()
    emit({ type: "exit", code: null, signal: null, error: message(err) })
    return { stop() {} }
  }
  emit({
    type: "spawned",
    pid: proc.pid,
    contained: tree.contained,
    ...(tree.jobHandle !== undefined ? { jobHandle: tree.jobHandle } : {}),
  })

  const log = openLog(spec)
  let finished = false
  const readers: { cancel(): Promise<void> }[] = []
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    readers.push(reader)
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || finished) break
        const data = decoder.decode(value, { stream: true })
        if (data) out(data)
      }
    } catch {}
    const rest = decoder.decode()
    if (rest && !finished) out(rest)
  }
  const out = (data: string) => {
    log.write(data)
    emit({ type: "output", data })
  }
  const drained = Promise.all([pump(proc.stdout), pump(proc.stderr)])
  if (gated) releaseGate(proc.stdin as Bun.FileSink, wrapped ? "go" : (spec.gateLine ?? ""))

  let exited = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  proc.exited.then(
    async () => {
      exited = true
      clearTimeout(killTimer)
      // The job is its main process: what it left running goes with it.
      tree.kill()
      await Promise.race([drained, Bun.sleep(JOB_DRAIN_MS)])
      finished = true
      for (const r of readers) r.cancel().catch(() => {})
      tree.dispose()
      const logError = await log.close()
      emit({
        type: "exit",
        code: proc.exitCode,
        signal: proc.signalCode,
        ...(logError ? { logError } : {}),
      })
    },
    () => {},
  )
  return {
    stop(graceMs) {
      if (exited) return
      clearTimeout(killTimer)
      if (graceMs > 0 && tree.terminate()) killTimer = setTimeout(() => exited || tree.kill(), graceMs)
      else tree.kill()
    },
  }
}

interface JobLog {
  write(data: string): void
  /** Flushes and closes the file; resolves with why it could not be written, if it could not. */
  close(): Promise<string | undefined>
}

/** The job's log file, written as output arrives so it can be read while the job runs. */
function openLog(spec: JobSpec): JobLog {
  if (!spec.logPath) return { write() {}, close: async () => undefined }
  const max = spec.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES
  let error: string | undefined
  let sink: Bun.FileSink | undefined
  try {
    mkdirSync(dirname(spec.logPath), { recursive: true })
    sink = Bun.file(spec.logPath).writer()
  } catch (err) {
    error = message(err)
  }
  let bytes = 0
  let full = false
  const guard = (f: () => unknown) => {
    try {
      const r = f()
      if (r instanceof Promise) r.catch((err) => (error ??= message(err)))
    } catch (err) {
      error ??= message(err)
      sink = undefined
    }
  }
  return {
    write(data) {
      if (!sink || full) return
      const size = Buffer.byteLength(data)
      if (bytes + size > max) {
        full = true
        guard(() => sink!.write(`\n[log stopped here: it reached ${max} bytes]\n`))
      } else {
        bytes += size
        guard(() => sink!.write(data))
      }
      guard(() => sink?.flush())
    },
    async close() {
      if (sink) {
        try {
          await sink.end()
        } catch (err) {
          error ??= message(err)
        }
      }
      return error
    },
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
