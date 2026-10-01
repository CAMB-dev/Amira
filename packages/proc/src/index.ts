import { type JobEvent, type JobHandle, type JobSpec, startJobInline } from "./job-inline.ts"
import { JobRegistry } from "./jobs.ts"
import { openPipeInline, type PipeEvent, type PipeHandle, type PipeSpec } from "./pipe.ts"
import { terminateJobHandle } from "./process-tree.ts"
import type { FromWorker, RunRequest, SpawnRequest, ToWorker } from "./protocol.ts"
import {
  outputCharLimit,
  type ReleaseOptions,
  type RunOptions,
  type RunResult,
  runCommandInline,
  type SpawnOptions,
  StandbyGoneError,
} from "./run-inline.ts"

export { cmdArgv } from "./cmd-line.ts"
export {
  DEFAULT_MAX_LOG_BYTES,
  JOB_DRAIN_MS,
  type JobEvent,
  type JobHandle,
  type JobSpec,
  startJobInline,
} from "./job-inline.ts"
export * from "./jobs.ts"
export type { PipeEvent, PipeSpec } from "./pipe.ts"
export { type ProcessTree, trackProcessTree, warmUpProcessTree } from "./process-tree.ts"
export {
  DEFAULT_MAX_OUTPUT_CHARS,
  DRAIN_GRACE_MS,
  type PreparedCommand,
  prepareCommandInline,
  type ReleaseOptions,
  type RunOptions,
  type RunResult,
  runCommandInline,
  type SpawnOptions,
  StandbyGoneError,
} from "./run-inline.ts"

interface Pending {
  opts: ReleaseOptions
  /** Runs the command on this thread if the worker never loads; absent for prepared commands. */
  inline?: () => Promise<RunResult>
  resolve: (r: RunResult) => void
  reject: (e: Error) => void
  onAbort: () => void
}

let workerUrl = new URL("./worker.ts", import.meta.url).href
let worker: Worker | undefined
/** The worker module loaded and answered at least once. */
let workerReady = false
/** Workers cannot be used here (e.g. the module is missing from a compiled binary); run inline. */
let workerBroken = false
let nextId = 1
const pending = new Map<number, Pending>()
/**
 * Keeps the process alive while commands run in the worker. The worker is ref'ed then too, but a
 * timer does not depend on how Bun handles ref() on a worker that has not started yet.
 */
let keepAlive: ReturnType<typeof setInterval> | undefined

function trackPending() {
  if (pending.size && !keepAlive) keepAlive = setInterval(() => {}, 1 << 30)
  else if (!pending.size && keepAlive) {
    clearInterval(keepAlive)
    keepAlive = undefined
  }
}
/** Prepared commands not yet released, by id; called when the worker reports them gone. */
const standbys = new Map<number, () => void>()

interface OpenPipe {
  spec: PipeSpec
  onEvent: (e: PipeEvent) => void
  /** Writes and the close sent before the worker loaded, replayed if it never does. */
  early: string[]
  closeGrace?: number
  /** Set when the worker never loaded and the process runs on this thread instead. */
  fallback?: PipeHandle
}
/** Piped processes in the worker that have not reported their exit. */
const pipes = new Map<number, OpenPipe>()

interface OpenJob {
  spec: JobSpec
  onEvent: (e: JobEvent) => void
  /** A stop sent before the worker loaded, replayed if it never does. */
  earlyStop?: number
  /** Set when the worker never loaded and the job runs on this thread instead. */
  fallback?: JobHandle
  pid?: number
  jobHandle?: number
}
/** Background jobs in the worker that have not reported their exit. */
const jobs = new Map<number, OpenJob>()

function getWorker(): Worker | undefined {
  if (worker || workerBroken) return worker
  try {
    // A compiled binary needs worker.ts as an extra entrypoint at this same relative path.
    const w = new Worker(workerUrl)
    // An idle worker must not keep the process alive; runCommand refs it while commands run.
    w.unref()
    w.onmessage = (e: MessageEvent<FromWorker>) => onMessage(e.data)
    // A load failure arrives asynchronously, as error and then close; handle both once.
    w.addEventListener("error", () => onWorkerGone(w))
    w.addEventListener("close", () => onWorkerGone(w))
    worker = w
    workerReady = false
  } catch {
    workerBroken = true
  }
  return worker
}

function onWorkerGone(w: Worker) {
  if (worker !== w) return
  worker = undefined
  w.terminate()
  // It never loaded: stop trying and run what was waiting on this thread instead.
  if (!workerReady) workerBroken = true
  abandonWorker(!workerReady)
}

/**
 * Settles everything that lived in a worker that is gone. Only a worker that never loaded is
 * known not to have released anything; after that a released standby may already have run
 * its command, so it must not look gone (its caller would run it a second time).
 */
function abandonWorker(neverLoaded: boolean) {
  for (const gone of [...standbys.values()]) gone()
  for (const [id, p] of pipes) {
    pipes.delete(id)
    if (neverLoaded) {
      p.fallback = inlinePipe(p.spec, p.onEvent)
      for (const data of p.early) p.fallback.write(data)
      if (p.closeGrace !== undefined) p.fallback.close(p.closeGrace)
    } else {
      // Its process may keep running; the caller should kill it by pid.
      pipeEvent(p.onEvent, { type: "exit", code: null, error: "the command worker stopped unexpectedly" })
    }
  }
  for (const [id, j] of jobs) {
    jobs.delete(id)
    if (neverLoaded) {
      j.fallback = startJobInline(j.spec, (e) => pipeEvent(j.onEvent, e))
      if (j.earlyStop !== undefined) j.fallback.stop(j.earlyStop)
    } else {
      // The worker's handles stay open (a stopped thread closes none), so its Job Object still
      // holds the whole tree: end it from here. Without one, kill by pid.
      if (j.jobHandle !== undefined) terminateJobHandle(j.jobHandle)
      else if (j.pid !== undefined) killJobTrees([j.pid])
      pipeEvent(j.onEvent, {
        type: "exit",
        code: null,
        signal: null,
        error: "the command worker stopped unexpectedly",
      })
    }
  }
  for (const [id, p] of pending) {
    pending.delete(id)
    p.opts.signal.removeEventListener("abort", p.onAbort)
    if (neverLoaded && p.inline) p.inline().then(p.resolve, p.reject)
    else if (neverLoaded) p.reject(new StandbyGoneError("the command worker did not load"))
    // It crashed after working; fail what was running and start a fresh worker next time.
    // Processes it started lose their job handles and may keep running.
    else p.reject(new Error("the command worker stopped unexpectedly"))
  }
  trackPending()
}

function onMessage(m: FromWorker) {
  if (!workerReady) {
    for (const p of pipes.values()) {
      p.early = []
      delete p.closeGrace
    }
    for (const j of jobs.values()) delete j.earlyStop
  }
  workerReady = true
  if (m.type === "ready") return
  if (m.type === "pipe") {
    const p = pipes.get(m.id)
    if (m.event.type === "exit") pipes.delete(m.id)
    if (p) pipeEvent(p.onEvent, m.event)
    return
  }
  if (m.type === "job") {
    const j = jobs.get(m.id)
    if (m.event.type === "exit") jobs.delete(m.id)
    if (m.event.type === "spawned" && j) {
      j.pid = m.event.pid
      if (m.event.jobHandle !== undefined) j.jobHandle = m.event.jobHandle
    }
    if (j) pipeEvent(j.onEvent, m.event)
    return
  }
  if (m.type === "gone") return standbys.get(m.id)?.()
  const p = pending.get(m.id)
  if (!p) return
  if (m.type === "chunk") {
    try {
      p.opts.onChunk?.(m.chunk)
    } catch {
      // A failing output callback must not break delivery of the rest.
    }
    return
  }
  pending.delete(m.id)
  trackPending()
  if (pending.size === 0) worker?.unref()
  p.opts.signal.removeEventListener("abort", p.onAbort)
  if (m.type === "done") p.resolve(m.result)
  else p.reject(m.gone ? new StandbyGoneError(m.error) : new Error(m.error))
}

/** Sends a run or release and settles with its result; the worker stays ref'ed meanwhile. */
function start(
  w: Worker,
  id: number,
  message: ToWorker,
  opts: ReleaseOptions,
  inline?: () => Promise<RunResult>,
) {
  return new Promise<RunResult>((resolve, reject) => {
    const onAbort = () => worker?.postMessage({ type: "abort", id } satisfies ToWorker)
    pending.set(id, { opts, resolve, reject, onAbort, ...(inline ? { inline } : {}) })
    // A running command keeps the process alive, or a caller awaiting it could see Bun exit.
    trackPending()
    w.ref()
    opts.signal.addEventListener("abort", onAbort, { once: true })
    w.postMessage(message)
    if (opts.signal.aborted) onAbort()
  })
}

/**
 * Runs a command in a worker thread, so a slow spawn cannot freeze the main thread
 * (and with it the UI). Same contract as `runCommandInline`; falls back to it when
 * workers are unavailable or a test seam is given.
 */
export function runCommand(argv: string[], opts: RunOptions): Promise<RunResult> {
  try {
    outputCharLimit(opts.maxOutputChars)
  } catch (err) {
    return Promise.reject(err)
  }
  const w = opts.trackTree ? undefined : getWorker()
  if (!w) return runCommandInline(argv, opts)
  const id = nextId++
  const request: RunRequest = {
    ...spawnRequest(argv, opts),
    timeoutMs: opts.timeoutMs,
    ...(opts.gateLine !== undefined ? { gateLine: opts.gateLine } : {}),
  }
  return start(w, id, { type: "run", id, request }, opts, () => runCommandInline(argv, opts))
}

/** A gated command started ahead of time in the worker; see `prepareCommand`. */
export interface Standby {
  /** False once it was run or disposed, or the worker reported that it exited or failed to start. */
  readonly alive: boolean
  /**
   * Releases the command; the timeout counts from here. Rejects with StandbyGoneError when the
   * process is gone, so the caller can run the command cold instead.
   */
  run(opts: ReleaseOptions): Promise<RunResult>
  /** Kills the process tree unless it was already run. */
  dispose(): void
}

/**
 * Starts a gated command in the worker and contains it, without releasing it: pays the process
 * start ahead of time. An idle standby does not keep this process alive, and it exits when this
 * process does (its stdin closes). Without a worker there is no standby: it is never alive.
 */
export function prepareCommand(argv: string[], opts: Omit<SpawnOptions, "trackTree">): Standby {
  outputCharLimit(opts.maxOutputChars)
  const w = getWorker()
  let state: "idle" | "released" | "gone" = w ? "idle" : "gone"
  const id = nextId++
  const markGone = () => {
    if (state !== "idle") return
    state = "gone"
    standbys.delete(id)
  }
  if (w) {
    standbys.set(id, markGone)
    w.postMessage({ type: "prepare", id, request: spawnRequest(argv, opts) } satisfies ToWorker)
  }
  return {
    get alive() {
      return state === "idle"
    },
    run(release) {
      const current = worker
      if (state !== "idle" || !current) {
        markGone()
        return Promise.reject(new StandbyGoneError("the standby process is gone"))
      }
      state = "released"
      standbys.delete(id)
      const request = {
        timeoutMs: release.timeoutMs,
        ...(release.gateLine !== undefined ? { gateLine: release.gateLine } : {}),
      }
      return start(current, id, { type: "release", id, request }, release)
    },
    dispose() {
      if (state !== "idle") return
      markGone()
      worker?.postMessage({ type: "dispose", id } satisfies ToWorker)
    },
  }
}

/** A long-lived process with piped stdio, started by `openPipe`. */
export interface PipeProcess {
  write(data: string): void
  /** Ends stdin, then kills the process tree if it has not exited after `graceMs`. */
  close(graceMs: number): void
}

/**
 * Starts a long-lived process with piped stdin, stdout and stderr (e.g. an MCP server) in the
 * command worker. Events arrive asynchronously: first "spawned" (or "exit" with an error when it
 * cannot start), then output, then one "exit". An open pipe does not keep this process alive;
 * when this process exits, the trees of pipes still running are killed (killLivePipes).
 *
 * Why the command worker: on Windows, libuv makes a child's pipe ends inheritable for the
 * duration of CreateProcess. A process started at that moment on another thread inherits them
 * and holds the pipes open, so the first child's output never ends while it lives (a command
 * would look unsettled). Spawning every piped process on one thread rules that race out; so no
 * other thread of Amira may spawn with pipes. Without a worker this runs on the calling thread,
 * where runCommand then runs too.
 */
export function openPipe(spec: PipeSpec, onEvent: (e: PipeEvent) => void): PipeProcess {
  onEvent = trackUntilExit(onEvent)
  const w = getWorker()
  if (!w) return inlinePipe(spec, onEvent)
  const id = nextId++
  const p: OpenPipe = { spec, onEvent, early: [] }
  pipes.set(id, p)
  w.postMessage({ type: "pipe-open", id, spec } satisfies ToWorker)
  return {
    write(data) {
      if (p.fallback) return p.fallback.write(data)
      if (!pipes.has(id)) return
      if (!workerReady) p.early.push(data)
      w.postMessage({ type: "pipe-write", id, data } satisfies ToWorker)
    },
    close(graceMs) {
      if (p.fallback) return p.fallback.close(graceMs)
      if (!pipes.has(id)) return
      if (!workerReady) p.closeGrace = graceMs
      w.postMessage({ type: "pipe-close", id, graceMs } satisfies ToWorker)
    },
  }
}

/** A background job started by `startJob`. */
export interface JobProcess {
  /** Stops its whole tree (see JobHandle.stop); its "exit" event follows. */
  stop(graceMs: number): void
}

/**
 * Starts a background job in the command worker: events arrive asynchronously, first
 * "spawned" (or "exit" with an error when it cannot start), then output, then one "exit".
 * A job does not keep this process alive. It is contained (on Windows a Job Object that kills
 * it when Amira exits, however it exits; on POSIX its own process group) and its tree is
 * killed when this process exits (killLiveJobs), when a SIGHUP or SIGTERM ends it, and when
 * the job's main process exits.
 */
export function startJob(spec: JobSpec, onEvent: (e: JobEvent) => void): JobProcess {
  onEvent = trackJobUntilExit(onEvent)
  const w = getWorker()
  if (!w) {
    let handle: JobHandle | undefined
    let early: number | undefined
    // Deferred, so callers see the same asynchronous events as with the worker.
    setTimeout(() => {
      handle = startJobInline(spec, (e) => pipeEvent(onEvent, e))
      if (early !== undefined) handle.stop(early)
    }, 0)
    return {
      stop(graceMs) {
        if (handle) handle.stop(graceMs)
        else early = graceMs
      },
    }
  }
  const id = nextId++
  const j: OpenJob = { spec, onEvent }
  jobs.set(id, j)
  const sent = spec.env ? { ...spec, env: plainEnv(spec.env) } : spec
  w.postMessage({ type: "job-start", id, spec: sent } satisfies ToWorker)
  return {
    stop(graceMs) {
      if (j.fallback) return j.fallback.stop(graceMs)
      if (!jobs.has(id)) return
      if (!workerReady) j.earlyStop = graceMs
      w.postMessage({ type: "job-stop", id, graceMs } satisfies ToWorker)
    },
  }
}

/** Main processes of background jobs that have not exited, for killLiveJobs. */
const liveJobs = new Set<number>()
let jobHooksInstalled = false

/**
 * Kills the trees of background jobs still running (startJob installs it as an exit hook).
 * On Windows their Job Objects kill them anyway as this process ends; taskkill /T covers a
 * job that could not be contained. On POSIX each job is its own process group.
 */
export function killLiveJobs(): void {
  if (!liveJobs.size) return
  const pids = [...liveJobs]
  liveJobs.clear()
  killJobTrees(pids)
}

function killJobTrees(pids: number[]) {
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/T", "/F", ...pids.flatMap((p) => ["/PID", String(p)])], {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
    } catch {}
    return
  }
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
  }
}

/**
 * Marks a signal listener that only cleans up and leaves what happens to the process to the
 * others: whoever decides whether a signal ends the process (such as the terminal's restore
 * handler, which only acts when nobody else listens) does not count it as a listener.
 */
export const PASSIVE_SIGNAL_LISTENER = Symbol.for("amira.passiveSignalListener")

const TERMINATING_SIGNALS = ["SIGHUP", "SIGTERM", "SIGINT"] as const
const SIGNAL_EXIT_CODES: Record<(typeof TERMINATING_SIGNALS)[number], number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
}

/**
 * A hangup (the terminal closed), SIGTERM, or a SIGINT nobody handles (e.g. Ctrl+C while print
 * mode shuts down, after it removed its own handler) would end Amira without running its exit
 * hooks, and jobs in process groups of their own never get the terminal's signal: they are
 * killed here first. When no listener that decides is left, this one ends the process as the
 * default action would have. A SIGINT someone handles (print mode interrupting a turn) is
 * theirs alone: jobs keep running.
 */
const onTerminatingSignal = Object.assign(
  (signal: NodeJS.Signals) => {
    const deciding = process
      .listeners(signal)
      .filter((l) => !(l as unknown as Record<symbol, unknown>)[PASSIVE_SIGNAL_LISTENER])
    if (signal === "SIGINT" && deciding.length) return
    killLiveJobs()
    if (!deciding.length) process.exit(SIGNAL_EXIT_CODES[signal as keyof typeof SIGNAL_EXIT_CODES] ?? 143)
  },
  { [PASSIVE_SIGNAL_LISTENER]: true },
)

/** While jobs run: kill them on exit and on a terminating signal. Removed again when none run. */
function setJobHooks(on: boolean) {
  if (on === jobHooksInstalled) return
  jobHooksInstalled = on
  for (const signal of TERMINATING_SIGNALS) {
    try {
      if (on) process.on(signal, onTerminatingSignal)
      else process.off(signal, onTerminatingSignal)
    } catch {}
  }
  if (on) process.on("exit", killLiveJobs)
  else process.off("exit", killLiveJobs)
}

/** Records a job's main process from "spawned" until its "exit", for killLiveJobs. */
function trackJobUntilExit(onEvent: (e: JobEvent) => void): (e: JobEvent) => void {
  let pid: number | undefined
  return (e) => {
    if (e.type === "spawned") {
      pid = e.pid
      liveJobs.add(e.pid)
      setJobHooks(true)
    } else if (e.type === "exit" && pid !== undefined) {
      // A lost worker's job was killed by pid already.
      liveJobs.delete(pid)
      if (!liveJobs.size) setJobHooks(false)
    }
    onEvent(e)
  }
}

/** Process ids of background jobs that have not exited yet (tests). */
export function liveJobPids(): number[] {
  return [...liveJobs]
}

/**
 * Piped processes (or their launchers) that have not exited yet, from spawn until exit, so one
 * still inside its close grace period is covered too.
 */
const livePipes = new Set<number>()
let exitHookInstalled = false

/**
 * Kills the trees of piped processes still running when this process exits (openPipe installs
 * it as an exit hook). Workers are gone by then, so this spawns on the main thread, without
 * pipes: taskkill /T, because killing only a launcher (cmd.exe, a .cmd shim such as npx.cmd)
 * leaves the real process running on Windows.
 */
export function killLivePipes(): void {
  if (!livePipes.size) return
  const pids = [...livePipes]
  livePipes.clear()
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/T", "/F", ...pids.flatMap((p) => ["/PID", String(p)])], {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
    } catch {}
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

/** Records a pipe's process from "spawned" until a real "exit", for killLivePipes. */
function trackUntilExit(onEvent: (e: PipeEvent) => void): (e: PipeEvent) => void {
  let pid: number | undefined
  return (e) => {
    if (e.type === "spawned") {
      pid = e.pid
      livePipes.add(e.pid)
      if (!exitHookInstalled) {
        exitHookInstalled = true
        process.once("exit", killLivePipes)
      }
    } else if (e.type === "exit" && pid !== undefined && !e.error) {
      // Without an error the process really exited; a lost worker may have left it running.
      livePipes.delete(pid)
    }
    onEvent(e)
  }
}

/** Process ids of piped processes that have not exited yet (tests). */
export function livePipePids(): number[] {
  return [...livePipes]
}

function pipeEvent<E>(onEvent: (e: E) => void, e: E) {
  try {
    onEvent(e)
  } catch {
    // A failing callback must not break delivery of the rest.
  }
}

/**
 * A piped process on this thread. Deferred, so callers see the same asynchronous events as
 * with the worker; writes and a close before the spawn wait for it.
 */
function inlinePipe(spec: PipeSpec, onEvent: (e: PipeEvent) => void): PipeProcess {
  let handle: PipeHandle | undefined
  const queue: ((h: PipeHandle) => void)[] = []
  const run = (f: (h: PipeHandle) => void) => (handle ? f(handle) : queue.push(f))
  setTimeout(() => {
    handle = openPipeInline(spec, (e) => pipeEvent(onEvent, e))
    for (const f of queue) f(handle)
  }, 0)
  return {
    write: (data) => void run((h) => h.write(data)),
    close: (graceMs) => void run((h) => h.close(graceMs)),
  }
}

/** Loads process-tree bindings in the worker ahead of the first command. */
export function warmUpCommands(): void {
  getWorker()?.postMessage({ type: "warmup" } satisfies ToWorker)
}

/** Test hook: forget the worker state, optionally loading the worker from another URL next. */
export function resetCommandWorker(opts: { url?: string } = {}): void {
  worker?.terminate()
  worker = undefined
  abandonWorker(false)
  workerReady = false
  workerBroken = false
  workerUrl = opts.url ?? new URL("./worker.ts", import.meta.url).href
}

function spawnRequest(argv: string[], opts: SpawnOptions): SpawnRequest {
  return {
    argv,
    cwd: opts.cwd,
    ...(opts.env ? { env: plainEnv(opts.env) } : {}),
    ...(opts.gated ? { gated: true } : {}),
    ...(opts.viaCmd ? { viaCmd: true } : {}),
    ...(opts.stdoutOnly ? { stdoutOnly: true } : {}),
    ...(opts.maxOutputChars !== undefined ? { maxOutputChars: opts.maxOutputChars } : {}),
  }
}

/** Environment objects may be getters or proxies; send a plain copy of string values. */
function plainEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v
  return out
}

/**
 * Amira's background jobs: one registry per process, since every job dies with the process.
 * Tools start and stop jobs here; frontends list them and ask before quitting while they run.
 */
export const backgroundJobs = new JobRegistry({ start: startJob })
