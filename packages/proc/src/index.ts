import type { FromWorker, RunRequest, ToWorker } from "./protocol.ts"
import { type RunOptions, type RunResult, runCommandInline } from "./run-inline.ts"

export { cmdArgv } from "./cmd-line.ts"
export { type ProcessTree, trackProcessTree, warmUpProcessTree } from "./process-tree.ts"
export { DRAIN_GRACE_MS, type RunOptions, type RunResult, runCommandInline } from "./run-inline.ts"

interface Pending {
  argv: string[]
  opts: RunOptions
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
  if (!workerReady) {
    // It never loaded: stop trying and run what was waiting on this thread instead.
    workerBroken = true
    for (const [id, p] of pending) {
      pending.delete(id)
      p.opts.signal.removeEventListener("abort", p.onAbort)
      runCommandInline(p.argv, p.opts).then(p.resolve, p.reject)
    }
    return
  }
  // It crashed after working; fail what was running and start a fresh worker next time.
  // Processes it started lose their job handles and may keep running.
  for (const [id, p] of pending) {
    pending.delete(id)
    p.opts.signal.removeEventListener("abort", p.onAbort)
    p.reject(new Error("the command worker stopped unexpectedly"))
  }
}

function onMessage(m: FromWorker) {
  workerReady = true
  if (m.type === "ready") return
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
  else p.reject(new Error(m.error))
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
    argv,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    ...(opts.env ? { env: plainEnv(opts.env) } : {}),
    ...(opts.gated ? { gated: true } : {}),
    ...(opts.gateLine !== undefined ? { gateLine: opts.gateLine } : {}),
    ...(opts.viaCmd ? { viaCmd: true } : {}),
    ...(opts.stdoutOnly ? { stdoutOnly: true } : {}),
  }
  return new Promise<RunResult>((resolve, reject) => {
    const onAbort = () => worker?.postMessage({ type: "abort", id } satisfies ToWorker)
    pending.set(id, { argv, opts, resolve, reject, onAbort })
    // A running command keeps the process alive, or a caller awaiting it could see Bun exit.
    w.ref()
    opts.signal.addEventListener("abort", onAbort, { once: true })
    w.postMessage({ type: "run", id, request } satisfies ToWorker)
    if (opts.signal.aborted) onAbort()
  })
}

/** Loads process-tree bindings in the worker ahead of the first command. */
export function warmUpCommands(): void {
  getWorker()?.postMessage({ type: "warmup" } satisfies ToWorker)
}

/** Test hook: forget the worker state, optionally loading the worker from another URL next. */
export function resetCommandWorker(opts: { url?: string } = {}): void {
  worker?.terminate()
  worker = undefined
  workerReady = false
  workerBroken = false
  workerUrl = opts.url ?? new URL("./worker.ts", import.meta.url).href
}

/** Environment objects may be getters or proxies; send a plain copy of string values. */
function plainEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v
  return out
}
