import { DEFAULT_UPDATE_CHANNEL, type Settings } from "@amira/api"
import { loadSettings } from "@amira/core"
import { UsageError } from "./args.ts"
import { type InstallSource, installSource, upgradeCommand } from "./install-source.ts"
import type { PrintIO } from "./print.ts"
import { createUpdater } from "./update/index.ts"
import { channel as buildChannel, version } from "./version.ts"

export type UpdateChannel = "stable" | "next"

export interface UpdateEngine {
  disabledReason(): Promise<string | undefined>
  check(channel?: UpdateChannel): Promise<{ version: string; channel: UpdateChannel }>
  update(channel?: UpdateChannel): Promise<string>
  rollback(minimumVersion?: string): Promise<string>
  cleanup(): Promise<void>
  /** Protect the loaded version for this session, independently of update policy. */
  pinVersion?(): Promise<void>
  /** Fence new activation and drain an already-started local install, not network downloads. */
  stop?(): Promise<void>
}

interface UpdateCommandOptions {
  updater?: UpdateEngine
  env?: Record<string, string | undefined>
  settings?: Settings
  source?: InstallSource
  version?: string
  signals?: {
    on(signal: string, handler: () => void): unknown
    off(signal: string, handler: () => void): unknown
  }
}

/** Environment switches accept the same explicit off values in every update entry point. */
export function updateSwitch(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false"
}

export function updateChannel(value: string | undefined): UpdateChannel {
  if (value === undefined) return buildChannel === "next" ? "next" : DEFAULT_UPDATE_CHANNEL
  if (value !== "stable" && value !== "next") throw new UsageError("--channel must be stable or next")
  return value
}

export function belowMinimum(target: string, minimum: string | undefined): boolean {
  return minimum !== undefined && Bun.semver.order(target, minimum) < 0
}

/** Built-in dispatch happens before package commands, and never loads credentials or extensions. */
export async function runUpdateCommand(
  argv: string[],
  io: PrintIO,
  options: UpdateCommandOptions = {},
): Promise<number | undefined> {
  const [command, ...rest] = argv
  if (command !== "update" && command !== "rollback") return undefined
  let check = false
  let selected: UpdateChannel | undefined
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!
    if (command === "update" && flag === "--check" && !check) check = true
    else if (command === "update" && flag === "--channel" && selected === undefined) {
      const value = rest[++i]
      if (!value) throw new UsageError("--channel requires stable or next")
      selected = updateChannel(value)
    } else if (command === "update" && flag.startsWith("--channel=") && selected === undefined) {
      selected = updateChannel(flag.slice("--channel=".length))
    } else throw new UsageError(`Unknown ${command} option: ${flag}`)
  }
  const env = options.env ?? process.env
  if (updateSwitch(env.AMIRA_DISABLE_UPDATES)) {
    io.stderr("amira: updates are disabled by AMIRA_DISABLE_UPDATES\n")
    return 1
  }
  const settings = options.settings ?? loadSettings({ cwd: process.cwd() }).settings
  const channel = selected ?? updateChannel(settings.updates?.channel)
  const source = options.source ?? installSource()
  const upgrade = upgradeCommand(source)
  if (upgrade) {
    if (command === "rollback") {
      io.stderr(
        `amira: managed rollback is unavailable for this ${source} installation. Use your package manager to select a version.\n`,
      )
      return 1
    }
    io.stdout(
      `This installation is managed by a package manager. Run: ${upgrade}${channel === "next" ? "@next" : ""}\n`,
    )
    return 0
  }
  const updater: UpdateEngine = options.updater ?? createUpdater()
  const signals = options.signals ?? process
  let interrupted: number | undefined
  const handlers = Object.entries({
    SIGINT: 130,
    SIGTERM: 143,
    SIGHUP: 129,
    ...(process.platform === "win32" ? { SIGBREAK: 130 } : {}),
  }).map(([signal, code]) => {
    const handler = () => {
      interrupted ??= code
      void updater.stop?.().catch(() => {})
    }
    signals.on(signal, handler)
    return { signal, handler }
  })
  try {
    if (command === "rollback") {
      const target = await updater.rollback(settings.updates?.minimumVersion)
      if (interrupted !== undefined) return interrupted
      io.stdout(`Rolled back to Amira ${target}. The change takes effect on the next start.\n`)
      return 0
    }
    const reason = await updater.disabledReason()
    if (interrupted !== undefined) return interrupted
    if (reason) {
      io.stderr(`amira: ${reason}\n`)
      return 1
    }
    if (updateSwitch(env.AMIRA_OFFLINE)) {
      io.stderr("amira: update downloads are disabled by AMIRA_OFFLINE; unset it and try again\n")
      return 1
    }
    const target = await updater.check(channel)
    if (interrupted !== undefined) return interrupted
    if (belowMinimum(target.version, settings.updates?.minimumVersion)) {
      io.stderr(
        `amira: release ${target.version} is below updates.minimumVersion (${settings.updates?.minimumVersion})\n`,
      )
      return 1
    }
    if (Bun.semver.order(target.version, options.version ?? version) <= 0) {
      io.stdout(`Amira ${options.version ?? version} is up to date on ${channel}.\n`)
      return 0
    }
    if (check) {
      io.stdout(
        `Amira ${target.version} is available on ${channel}. Run amira update --channel ${channel} to install it.\n`,
      )
      return 0
    }
    const installed = await updater.update(channel)
    if (interrupted !== undefined) return interrupted
    io.stdout(`Updated to Amira ${installed}. The change takes effect on the next start.\n`)
    return 0
  } catch (error) {
    if (interrupted !== undefined) return interrupted
    throw error
  } finally {
    // Keep cancellation handlers installed while draining a local rename/copy/restore.
    await updater.stop?.().catch(() => {})
    for (const { signal, handler } of handlers) signals.off(signal, handler)
  }
}
