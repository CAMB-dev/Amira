import { prepareCommand, type RunResult, runCommand, type Standby, StandbyGoneError } from "@amira/proc"
import type { ShellCommand } from "./shell.ts"

export interface PoolRunOptions {
  timeoutMs: number
  signal: AbortSignal
  onChunk?: (chunk: string) => void
}

export interface StandbyPoolDeps {
  prepare?: typeof prepareCommand
  run?: typeof runCommand
}

/**
 * Keeps one gated shell process started and waiting, so a command skips the process start
 * (hundreds of ms for PowerShell, more under antivirus). A standby only serves a command with
 * the same argv, start directory and environment; every command still gets a fresh process.
 * Calls that find no matching standby run cold, as do parallel calls beyond the one standby.
 */
export class StandbyPool {
  #slot: { key: string; standby: Standby } | undefined
  readonly #prepare: typeof prepareCommand
  readonly #run: typeof runCommand

  constructor(deps: StandbyPoolDeps = {}) {
    this.#prepare = deps.prepare ?? prepareCommand
    this.#run = deps.run ?? runCommand
  }

  /** Runs the command on the standby when it matches, else cold; either way refills the pool. */
  async run(command: ShellCommand, opts: PoolRunOptions): Promise<RunResult> {
    const { argv, gateLine, ...spawn } = command
    const cold = () => this.#run(argv, { ...spawn, ...opts, ...(gateLine !== undefined ? { gateLine } : {}) })
    if (!command.gated || command.viaCmd) return cold()
    const key = standbyKey(command)
    const slot = this.#slot
    const taken = slot?.key === key && slot.standby.alive
    if (taken) this.#slot = undefined
    // Released (or started) before the refill is posted, so the worker handles this command first.
    const running = taken
      ? slot.standby.run({
          timeoutMs: opts.timeoutMs,
          signal: opts.signal,
          ...(gateLine !== undefined ? { gateLine } : {}),
          ...(opts.onChunk ? { onChunk: opts.onChunk } : {}),
        })
      : cold()
    this.fill(command)
    if (!taken) return running
    try {
      return await running
    } catch (err) {
      if (!(err instanceof StandbyGoneError)) throw err
      return cold()
    }
  }

  /** Starts a standby for commands like this one, unless a matching one is already waiting. */
  fill(command: ShellCommand): void {
    if (!command.gated || command.viaCmd) return
    const key = standbyKey(command)
    if (this.#slot?.key === key && this.#slot.standby.alive) return
    this.#slot?.standby.dispose()
    this.#slot = undefined
    const { argv, gateLine: _, ...spawn } = command
    try {
      this.#slot = { key, standby: this.#prepare(argv, spawn) }
    } catch {}
  }

  /** Kills the waiting standby, if any. */
  dispose(): void {
    this.#slot?.standby.dispose()
    this.#slot = undefined
  }
}

/** Everything the process is started with; the gate line is sent later, so it is not part of it. */
function standbyKey(command: ShellCommand): string {
  const env = Object.entries(command.env)
    .filter((e): e is [string, string] => typeof e[1] === "string")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify([command.argv, command.cwd, env])
}
