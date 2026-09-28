import type { RunResult } from "./run-inline.ts"

export interface SpawnRequest {
  argv: string[]
  cwd: string
  env?: Record<string, string | undefined>
  gated?: boolean
  viaCmd?: boolean
  stdoutOnly?: boolean
}

export interface ReleaseRequest {
  gateLine?: string
  timeoutMs: number
}

export type RunRequest = SpawnRequest & ReleaseRequest

/** Main thread → worker. A prepared command keeps its id when it is released. */
export type ToWorker =
  | { type: "run"; id: number; request: RunRequest }
  | { type: "prepare"; id: number; request: SpawnRequest }
  | { type: "release"; id: number; request: ReleaseRequest }
  | { type: "dispose"; id: number }
  | { type: "abort"; id: number }
  | { type: "warmup" }

/** Worker → main thread. */
export type FromWorker =
  /** Sent once the worker module has loaded, so load failures can be told apart from crashes. */
  | { type: "ready" }
  | { type: "chunk"; id: number; chunk: string }
  | { type: "done"; id: number; result: RunResult }
  /** `gone`: a released prepared command could not run (see StandbyGoneError). */
  | { type: "failed"; id: number; error: string; gone?: boolean }
  /** A prepared command failed to start or exited before it was released. */
  | { type: "gone"; id: number }
