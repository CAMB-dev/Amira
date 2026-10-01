import type { ShellKind } from "./tools.ts"

/** The lifecycle of a command that continues after the call that started it. */
export type BackgroundJobStatus = "starting" | "running" | "exited" | "stopped" | "failed"

export interface BackgroundJobInfo {
  readonly id: string
  readonly command: string
  readonly cwd: string
  /** The owning sub-agent. Top-level session jobs have no public owner. */
  readonly owner?: string
  readonly meta: Readonly<Record<string, unknown>>
  readonly startedAt: number
  readonly status: BackgroundJobStatus
  readonly pid?: number
  readonly contained: boolean
  readonly exitCode: number | null
  readonly signal: string | null
  readonly error?: string
  readonly endedAt?: number
  readonly stopRequested: boolean
  readonly outputChars: number
  readonly logPath?: string
  readonly logError?: string
}

export interface BackgroundJobOutput {
  text: string
  from: number
  to: number
  /** Characters after the requested offset that the in-memory buffer no longer holds. */
  dropped: number
}

export interface BackgroundJobWaitResult {
  reason: "match" | "exit" | "timeout" | "aborted"
  line?: string
}

export interface BackgroundJobChange {
  type: "start" | "status" | "output" | "end"
  job: BackgroundJobInfo
}

/** The process details a session supplies when it starts a background job. */
export interface BackgroundJobStartOptions {
  /** The command as shown to the user and model. */
  command: string
  /** The already shell-encoded command; the API does not reinterpret shell syntax. */
  argv: string[]
  cwd: string
  env?: Record<string, string | undefined>
  /** The shell used to interpret `command`, when the caller is running a shell. */
  shell?: ShellKind
  /** The command waits for a line before it runs, so its process tree can be contained first. */
  gated?: boolean
  gateLine?: string
  viaCmd?: boolean
  /** Write the complete bounded log under this directory as well as keeping a memory buffer. */
  logDir?: string
  maxLogBytes?: number
  meta?: Record<string, unknown>
}

export interface BackgroundJobWaitOptions {
  pattern?: RegExp
  from?: number
  timeoutMs: number
  signal?: AbortSignal
}

/** Operations available to extensions and to a session-scoped view. */
export interface BackgroundJobOperations {
  start(options: BackgroundJobStartOptions): BackgroundJobInfo
  get(id: string): BackgroundJobInfo | undefined
  list(): BackgroundJobInfo[]
  running(): BackgroundJobInfo[]
  output(id: string, from?: number): BackgroundJobOutput
  tail(id: string, maxChars: number): string
  cursor(id: string, reader: string): number
  readNew(id: string, reader: string, maxChars?: number): BackgroundJobOutput
  markRead(id: string, reader: string, to?: number): void
  waitFor(id: string, options: BackgroundJobWaitOptions): Promise<BackgroundJobWaitResult>
  stop(id: string, graceMs?: number): Promise<BackgroundJobInfo>
  subscribe(listener: (change: BackgroundJobChange) => void): () => void
  /** True when start rejected the job because the configured live-job limit was reached. */
  isLimitError(error: unknown): error is Error
}

/** The process-wide host view. Settings configure this view; tools use a session view instead. */
export interface BackgroundJobRegistry extends BackgroundJobOperations {
  stopAll(which?: (job: BackgroundJobInfo) => boolean, graceMs?: number): Promise<BackgroundJobInfo[]>
  configure(limits: { maxRunning?: number; bufferChars?: number }): void
  readonly maxRunning: number
}

/** An extension's own background jobs; host-wide lifecycle operations are not available here. */
export type BackgroundJobExtension = BackgroundJobOperations

export interface BackgroundJobSessionInfo {
  sessionId: string
  depth: number
  parentSessionId?: string
  /** Usually inferred from the parent; hosts may supply it when constructing a session directly. */
  rootSessionId?: string
}

/** A caller-scoped view: top-level sessions see their tree, sub-agents see only themselves. */
export interface BackgroundJobSession extends BackgroundJobOperations {
  readonly sessionId: string
  readonly depth: number
  stopAll(which?: (job: BackgroundJobInfo) => boolean, graceMs?: number): Promise<BackgroundJobInfo[]>
}

/** Host operations used by built-in frontends and core to close session lifetimes. */
export interface BackgroundJobHost extends BackgroundJobRegistry {
  forSession(info: BackgroundJobSessionInfo): BackgroundJobSession
  /** Stops jobs owned by a sub-agent and invalidates its session view. */
  closeSession(sessionId: string, graceMs?: number): Promise<BackgroundJobInfo[]>
  /** Stops all jobs belonging to a top-level session, including its sub-agents. */
  closeRoot(rootSessionId: string, graceMs?: number): Promise<BackgroundJobInfo[]>
  /** Hands top-level jobs to a replacement root and stops jobs owned by its sub-agents. */
  handoverRoot(
    rootSessionId: string,
    nextRootSessionId: string,
    graceMs?: number,
  ): Promise<BackgroundJobInfo[]>
}
