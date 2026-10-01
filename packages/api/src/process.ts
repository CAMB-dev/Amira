export interface RunCommandOptions {
  cwd: string
  env?: Record<string, string | undefined>
  /** Milliseconds before the command and everything it started are killed. */
  timeoutMs: number
  signal: AbortSignal
  /** Called with each new piece of output, in order, while the command runs. */
  onChunk?: (chunk: string) => void
  /**
   * Keep only the last this many characters in the result's `output`, so a chatty command cannot
   * fill memory; onChunk still sees everything. Default: 1,000,000. Must be a positive integer.
   */
  maxOutputChars?: number
  /** Keep stderr out of the output (it is discarded). Default: both are interleaved. */
  stdoutOnly?: boolean
  /**
   * The command must wait for one line on stdin before doing anything; the host sends it
   * once the process tree is contained, so nothing it starts can escape a kill.
   */
  gated?: boolean
  /**
   * Text for the command's stdin, e.g. JSON describing what a hook runs for. It is written once
   * the process tree is contained, followed by a newline (unless it ends with one), and then
   * stdin is closed. Without it the command gets no stdin (or only the gate line). Cannot be
   * combined with `gated` or `viaCmd`.
   */
  stdin?: string
  /** Windows: start through cmd.exe, which avoids the long spawn stalls some machines have with git. */
  viaCmd?: boolean
}

export interface RunCommandResult {
  output: string
  /** True when `output` was shortened to `maxOutputChars`. */
  truncated: boolean
  exitCode: number | null
  signalCode: string | null
  /** The timeout fired before the command exited. */
  timedOut: boolean
  aborted: boolean
  /** False when output pipes stayed open after the command ended, i.e. something kept running. */
  settled: boolean
  /** False when the process tree could not be contained, so kills may have missed processes. */
  contained: boolean
}

/** What a process started with ExtensionAPI.openPipe reports, in order. */
export type PipeEvent =
  | { type: "spawned"; pid: number }
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  /**
   * The last event. `error`: the process failed to start (then no "spawned" came before), or
   * the host lost track of it (it may still run).
   */
  | { type: "exit"; code: number | null; error?: string }

export interface OpenPipeOptions {
  cwd: string
  /** The whole environment of the process. Default: Amira's own. */
  env?: Record<string, string | undefined>
  /** Called with each event; a throw is ignored and does not stop later events. */
  onEvent(event: PipeEvent): void
}

/** A long-lived process with piped stdio, e.g. a language server (ExtensionAPI.openPipe). */
export interface PipeProcess {
  /** Writes to its stdin; ignored once it has exited. Writes before "spawned" are kept for it. */
  write(data: string): void
  /** Ends its stdin, then kills its process tree if it has not exited after `graceMs`. */
  close(graceMs: number): void
}

/** The result of a host command started by built-in tools. */
export interface HostRunResult {
  output: string
  exitCode: number | null
  signalCode: string | null
  timedOut: boolean
  aborted: boolean
  settled: boolean
  contained: boolean
}

/** Fixed process settings accepted by the built-in shell tools. */
export interface HostSpawnOptions {
  cwd: string
  env?: Record<string, string | undefined>
  gated?: boolean
  viaCmd?: boolean
  stdoutOnly?: boolean
  maxOutputChars?: number
}

/** Release settings accepted by a normal or prepared host command. */
export interface HostReleaseOptions {
  gateLine?: string
  timeoutMs: number
  signal: AbortSignal
  onChunk?: (chunk: string) => void
}

/** Options accepted by the built-in host command runner. */
export interface HostRunOptions extends HostSpawnOptions, HostReleaseOptions {}

/** A command spawned ahead of time and released once its caller is ready. */
export interface HostPreparedCommand {
  readonly alive: boolean
  run(options: HostReleaseOptions): Promise<HostRunResult>
  dispose(): void
}

export type HostRunCommand = (argv: string[], options: HostRunOptions) => Promise<HostRunResult>
export type HostPrepareCommand = (argv: string[], options: HostSpawnOptions) => HostPreparedCommand

/**
 * The host implementation behind the selected process capabilities below. Core installs this
 * once before loading extensions; API deliberately has no dependency on the host's process
 * implementation.
 */
export interface HostProcessService {
  runCommand: HostRunCommand
  prepareCommand: HostPrepareCommand
  warmUpCommands(): void
  openPipe(argv: string[], options: OpenPipeOptions): PipeProcess
  backgroundJobs: BackgroundJobRegistry
  isStandbyGoneError(error: unknown): boolean
  isBackgroundJobLimitError(error: unknown): boolean
}

let hostProcess: HostProcessService | undefined

/** @internal Called by the host before it loads any extension. */
export function installHostProcess(service: HostProcessService): void {
  hostProcess = service
}

function requireHostProcess(): HostProcessService {
  if (!hostProcess) throw new Error("Amira's host process service has not been installed")
  return hostProcess
}

/** Selected host process capabilities for built-in extensions. */
export function hostRunCommand(argv: string[], options: HostRunOptions): Promise<HostRunResult> {
  return requireHostProcess().runCommand(argv, options)
}

/** Starts a gated command ahead of time for a built-in shell tool. */
export function hostPrepareCommand(argv: string[], options: HostSpawnOptions): HostPreparedCommand {
  return requireHostProcess().prepareCommand(argv, options)
}

/** Warms the host's command worker without exposing the worker implementation. */
export function hostWarmUpCommands(): void {
  requireHostProcess().warmUpCommands()
}

/** The host-specific error used when a prepared command can no longer be released. */
export function isHostStandbyGoneError(error: unknown): boolean {
  return requireHostProcess().isStandbyGoneError(error)
}

/**
 * Temporary D97 step-1 background-job bridge. It exposes only what builtin-tools currently
 * consumes; a later background-jobs API should replace this with a session-scoped contract.
 */
export type BackgroundJobStatus = "starting" | "running" | "exited" | "stopped" | "failed"

export interface BackgroundJobInfo {
  readonly id: string
  readonly command: string
  readonly cwd: string
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

export interface BackgroundJobStartOptions {
  command: string
  argv: string[]
  cwd: string
  env?: Record<string, string | undefined>
  gated?: boolean
  gateLine?: string
  viaCmd?: boolean
  logDir?: string
  maxLogBytes?: number
  owner?: string
  meta?: Record<string, unknown>
}

export interface BackgroundJobRegistry {
  configure(limits: { maxRunning?: number; bufferChars?: number }): void
  start(options: BackgroundJobStartOptions): BackgroundJobInfo
  get(id: string): BackgroundJobInfo | undefined
  list(): BackgroundJobInfo[]
  running(): BackgroundJobInfo[]
  output(id: string, from?: number): BackgroundJobOutput
  tail(id: string, maxChars: number): string
  cursor(id: string, reader: string): number
  readNew(id: string, reader: string, maxChars?: number): BackgroundJobOutput
  waitFor(
    id: string,
    options: { pattern?: RegExp; from?: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<BackgroundJobWaitResult>
  stop(id: string, graceMs?: number): Promise<BackgroundJobInfo>
  stopAll(which?: (job: BackgroundJobInfo) => boolean, graceMs?: number): Promise<BackgroundJobInfo[]>
  subscribe(listener: (change: BackgroundJobChange) => void): () => void
}

export type TemporaryBackgroundJobRegistry = BackgroundJobRegistry
/**
 * The temporary registry forwards to the host service so importing an extension never imports
 * the process package. It is intentionally not a public background-jobs abstraction yet.
 */
export const temporaryBackgroundJobs: TemporaryBackgroundJobRegistry = new Proxy(
  {} as TemporaryBackgroundJobRegistry,
  {
    get(_target, property) {
      const registry = requireHostProcess().backgroundJobs as unknown as Record<PropertyKey, unknown>
      const value = registry[property]
      return typeof value === "function" ? value.bind(registry) : value
    },
  },
)

/** Temporary defaults kept in sync with the host registry until the follow-up API lands. */
export const TEMPORARY_DEFAULT_BUFFER_CHARS = 1_000_000
export const TEMPORARY_DEFAULT_MAX_RUNNING = 8

/** Whether an error means the host rejected a job because its live-job limit was reached. */
export function isTemporaryBackgroundJobLimitError(error: unknown): error is Error {
  return requireHostProcess().isBackgroundJobLimitError(error)
}

/**
 * Opens a long-lived process for an extension. This has the same containment and worker
 * semantics as ExtensionAPI.openPipe; the top-level form is also useful to extension-owned
 * helpers that are tested without an ExtensionAPI instance.
 */
export function openPipe(argv: string[], options: OpenPipeOptions): PipeProcess {
  return requireHostProcess().openPipe(argv, options)
}
