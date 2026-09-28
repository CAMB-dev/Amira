import type { FromWorker, RunRequest, ToWorker } from "./protocol.ts"
import { type RunOptions, type RunResult, runCommandInline } from "./run-inline.ts"

export { type ProcessTree, trackProcessTree, warmUpProcessTree } from "./process-tree.ts"
export { DRAIN_GRACE_MS, type RunOptions, type RunResult, runCommandInline } from "./run-inline.ts"

interface Pending {
  opts: RunOptions
  output: string
  resolve: (r: RunResult) => void
  reject: (e: Error) => void
  onAbort: () => void
}

let worker: Worker | undefined
let workerBroken = false
let nextId = 1
const pending = new Map<number, Pending>()

function getWorker(): Worker | undefined {
  if (worker || workerBroken) return worker
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url).href)
    // Idle commands must not keep the process alive.
    worker.unref()
    worker.onmessage = (e: MessageEvent<FromWorker>) => onMessage(e.data)
    worker.onerror = () => failAll("the command worker crashed")
  } catch {
    workerBroken = true
    worker = undefined
  }
  return worker
}

function onMessage(m: FromWorker) {
  const p = pending.get(m.id)
  if (!p) return
  if (m.type === "chunk") {
    p.output += m.chunk
    p.opts.onChunk?.(m.chunk)
    return
  }
  pending.delete(m.id)
  p.opts.signal.removeEventListener("abort", p.onAbort)
  if (m.type === "done") p.resolve(m.result)
  else p.reject(new Error(m.error))
}

function failAll(error: string) {
  for (const [id, p] of pending) {
    pending.delete(id)
    p.reject(new Error(error))
  }
  worker?.terminate()
  worker = undefined
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
    ...(opts.stdoutOnly ? { stdoutOnly: true } : {}),
  }
  return new Promise<RunResult>((resolve, reject) => {
    const onAbort = () => w.postMessage({ type: "abort", id } satisfies ToWorker)
    pending.set(id, { opts, output: "", resolve, reject, onAbort })
    opts.signal.addEventListener("abort", onAbort, { once: true })
    w.postMessage({ type: "run", id, request } satisfies ToWorker)
    if (opts.signal.aborted) onAbort()
  })
}

/** Loads process-tree bindings in the worker ahead of the first command. */
export function warmUpCommands(): void {
  getWorker()?.postMessage({ type: "warmup" } satisfies ToWorker)
}

/** Environment objects may be getters or proxies; send a plain copy of string values. */
function plainEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v
  return out
}
