import type { RunResult } from "./run-inline.ts"

export interface RunRequest {
  argv: string[]
  cwd: string
  env?: Record<string, string | undefined>
  gated?: boolean
  timeoutMs: number
  stdoutOnly?: boolean
}

/** Main thread → worker. */
export type ToWorker =
  | { type: "run"; id: number; request: RunRequest }
  | { type: "abort"; id: number }
  | { type: "warmup" }

/** Worker → main thread. */
export type FromWorker =
  /** Sent once the worker module has loaded, so load failures can be told apart from crashes. */
  | { type: "ready" }
  | { type: "chunk"; id: number; chunk: string }
  | { type: "done"; id: number; result: RunResult }
  | { type: "failed"; id: number; error: string }
