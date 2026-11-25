import { DEFAULT_UPDATE_CHANNEL, type Settings } from "@amira/api"
import { loadSettings } from "@amira/host"
import { UsageError } from "./args.ts"
import { type InstallSource, installSource, upgradeCommand } from "./install-source.ts"
import type { PrintIO } from "./print.ts"
import { createUpdater, type UpdateProgress } from "./update/index.ts"
import { formatBytes } from "./update/manifest.ts"
import { parseVersion } from "./update/semver.ts"
import { channel as buildChannel, version } from "./version.ts"

export type UpdateChannel = "stable" | "next"

export interface UpdateEngine {
  disabledReason(): Promise<string | undefined>
  check(channel?: UpdateChannel): Promise<{ version: string; channel: UpdateChannel }>
  checkVersion?(version: string): Promise<{ version: string; channel: UpdateChannel }>
  update(channel?: UpdateChannel): Promise<string>
  updateVersion?(version: string): Promise<string>
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

function parseTargetVersion(value: string): string {
  const normalized = value.replace(/^v/, "")
  if (!parseVersion(normalized))
    throw new UsageError(`--version must be a valid semver version (got ${value})`)
  return normalized
}

function createProgressReporter(io: PrintIO) {
  const isTTY = Boolean(process.stderr.isTTY)
  let lastDraw = 0
  let active = false
  const clear = () => {
    if (!active) return
    active = false
    if (isTTY) io.stderr("\r\x1b[2K")
  }
  const onProgress = (progress: UpdateProgress) => {
    if (!isTTY) return
    const now = Date.now()
    if (progress.phase === "download") {
      const loaded = progress.loaded ?? 0
      const total = progress.total
      if (loaded > 0 && total !== undefined && loaded < total && now - lastDraw < 120) return
      lastDraw = now
      const pct = total && total > 0 ? ` (${Math.min(100, Math.round((loaded / total) * 100))}%)` : ""
      const range = total ? `${formatBytes(loaded)} / ${formatBytes(total)}` : formatBytes(loaded)
      io.stderr(`\r\x1b[2KDownloading Amira ${progress.version ?? ""}… ${range}${pct}`)
      active = true
    } else if (progress.phase === "verify") {
      io.stderr(`\r\x1b[2KVerifying Amira ${progress.version ?? ""} (SHA-256 & signature)…`)
      active = true
    } else if (progress.phase === "install") {
      io.stderr(`\r\x1b[2KInstalling Amira ${progress.version ?? ""}…`)
      active = true
    }
  }
  return { onProgress, clear }
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
  let requestedVersion: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!
    if (command === "update" && flag === "--check" && !check) check = true
    else if (command === "update" && flag === "--channel" && selected === undefined) {
      const value = rest[++i]
      if (!value) throw new UsageError("--channel requires stable or next")
      selected = updateChannel(value)
    } else if (command === "update" && flag.startsWith("--channel=") && selected === undefined) {
      selected = updateChannel(flag.slice("--channel=".length))
    } else if (command === "update" && flag === "--version" && requestedVersion === undefined) {
      const value = rest[++i]
      if (!value) throw new UsageError("--version requires a version (e.g. 0.0.2)")
      requestedVersion = parseTargetVersion(value)
    } else if (command === "update" && flag.startsWith("--version=") && requestedVersion === undefined) {
      requestedVersion = parseTargetVersion(flag.slice("--version=".length))
    } else throw new UsageError(`Unknown ${command} option: ${flag}`)
  }
  if (selected !== undefined && requestedVersion !== undefined) {
    throw new UsageError("--version cannot be combined with --channel")
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
    const suffix = requestedVersion ? `@${requestedVersion}` : channel === "next" ? "@next" : ""
    io.stdout(`This installation is managed by a package manager. Run: ${upgrade}${suffix}\n`)
    return 0
  }
  const progress = options.updater ? undefined : createProgressReporter(io)
  const updater: UpdateEngine = options.updater ?? createUpdater({ onProgress: progress?.onProgress })
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
    const currentVersion = options.version ?? version
    if (requestedVersion) {
      if (!updater.checkVersion || !updater.updateVersion) {
        io.stderr("amira: explicit version updates are unavailable in this updater\n")
        return 1
      }
      const target = await updater.checkVersion(requestedVersion)
      if (interrupted !== undefined) return interrupted
      if (belowMinimum(target.version, settings.updates?.minimumVersion)) {
        io.stderr(
          `amira: release ${target.version} is below updates.minimumVersion (${settings.updates?.minimumVersion})\n`,
        )
        return 1
      }
      if (target.version === currentVersion) {
        io.stdout(`Amira ${currentVersion} is already installed.\n`)
        return 0
      }
      if (check) {
        io.stdout(
          `Amira ${target.version} (${target.channel}) is available on GitHub Releases. Run amira update --version ${target.version} to install it.\n`,
        )
        return 0
      }
      const installed = await updater.updateVersion(target.version)
      progress?.clear()
      if (interrupted !== undefined) return interrupted
      io.stdout(`Updated to Amira ${installed}. The change takes effect on the next start.\n`)
      return 0
    }
    const target = await updater.check(channel)
    if (interrupted !== undefined) return interrupted
    if (belowMinimum(target.version, settings.updates?.minimumVersion)) {
      io.stderr(
        `amira: release ${target.version} is below updates.minimumVersion (${settings.updates?.minimumVersion})\n`,
      )
      return 1
    }
    if (Bun.semver.order(target.version, currentVersion) <= 0) {
      io.stdout(`Amira ${currentVersion} is up to date on ${channel}.\n`)
      return 0
    }
    if (check) {
      io.stdout(
        `Amira ${target.version} is available on ${channel}. Run amira update --channel ${channel} to install it.\n`,
      )
      return 0
    }
    const installed = await updater.update(channel)
    progress?.clear()
    if (interrupted !== undefined) return interrupted
    io.stdout(`Updated to Amira ${installed}. The change takes effect on the next start.\n`)
    return 0
  } catch (error) {
    progress?.clear()
    if (interrupted !== undefined) return interrupted
    throw error
  } finally {
    progress?.clear()
    // Keep cancellation handlers installed while draining a local rename/copy/restore.
    await updater.stop?.().catch(() => {})
    for (const { signal, handler } of handlers) signals.off(signal, handler)
  }
}
