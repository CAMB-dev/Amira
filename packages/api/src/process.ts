import type { BackgroundJobHost } from "./background-jobs.ts"

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
  isStandbyGoneError(error: unknown): boolean
  /** The host-owned background jobs exposed through ExtensionAPI and session views. */
  backgroundJobs: BackgroundJobHost
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

/** The host-owned background jobs, for extension panels and other host-level integrations. */
export function hostBackgroundJobs(): BackgroundJobHost {
  return requireHostProcess().backgroundJobs
}

/**
 * Opens a long-lived process for an extension. This has the same containment and worker
 * semantics as ExtensionAPI.openPipe; the top-level form is also useful to extension-owned
 * helpers that are tested without an ExtensionAPI instance.
 */
export function openPipe(argv: string[], options: OpenPipeOptions): PipeProcess {
  return requireHostProcess().openPipe(argv, options)
}
