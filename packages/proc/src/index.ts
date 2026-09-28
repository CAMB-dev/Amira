import type { FromWorker, RunRequest, SpawnRequest, ToWorker } from "./protocol.ts"
import {
  type ReleaseOptions,
  type RunOptions,
  type RunResult,
  runCommandInline,
  type SpawnOptions,
  StandbyGoneError,
} from "./run-inline.ts"

export { cmdArgv } from "./cmd-line.ts"
export { type ProcessTree, trackProcessTree, warmUpProcessTree } from "./process-tree.ts"
export {
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
/** Prepared commands not yet released, by id; called when the worker reports them gone. */
const standbys = new Map<number, () => void>()

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
  for (const [id, p] of pending) {
    pending.delete(id)
    p.opts.signal.removeEventListener("abort", p.onAbort)
    if (neverLoaded && p.inline) p.inline().then(p.resolve, p.reject)
    else if (neverLoaded) p.reject(new StandbyGoneError("the command worker did not load"))
    // It crashed after working; fail what was running and start a fresh worker next time.
    // Processes it started lose their job handles and may keep running.
    else p.reject(new Error("the command worker stopped unexpectedly"))
  }
}

function onMessage(m: FromWorker) {
  workerReady = true
  if (m.type === "ready") return
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
  }
}

/** Environment objects may be getters or proxies; send a plain copy of string values. */
function plainEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v
  return out
}
