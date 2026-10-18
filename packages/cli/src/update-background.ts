import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { DEFAULT_UPDATE_AUTO, type Settings } from "@amira/api"
import { amiraPath, tryFileLock } from "@amira/core"
import { createUpdater } from "./update/index.ts"
import { parseVersion } from "./update/semver.ts"
import {
  belowMinimum,
  type UpdateChannel,
  type UpdateEngine,
  updateChannel,
  updateSwitch,
} from "./update-command.ts"
import { version } from "./version.ts"

export const UPDATE_CHECK_INTERVAL_MS = 22 * 60 * 60 * 1000

interface UpdateState {
  checkedAt: number
  channel: UpdateChannel
  available?: string
}

interface BackgroundOptions {
  updater?: UpdateEngine
  env?: Record<string, string | undefined>
  version?: string
  stateFile?: string
  now?: () => number
  /** RPC sessions only hold a version lease; they do not check, prune or show notices. */
  checks?: boolean
  /** Publish the activation fence before any background work starts. */
  onStop?: (stop: () => Promise<void>) => void
}

export interface BackgroundUpdate {
  notice?: string
  /** Best effort only: shutdown must never wait for update networking. */
  finished: Promise<void>
  /** Normal exit waits for local activation only, so a Windows swap cannot be interrupted. */
  stop(): Promise<void>
}

/** Prereleases compare semantically; only the same major/minor line is automatic. */
export function updatePolicy(current: string, target: string, minimum?: string): "none" | "patch" | "notice" {
  if (Bun.semver.order(target, current) <= 0 || belowMinimum(target, minimum)) return "none"
  const currentLine = /^(\d+)\.(\d+)\./.exec(current)
  const targetLine = /^(\d+)\.(\d+)\./.exec(target)
  return currentLine?.[1] === targetLine?.[1] && currentLine?.[2] === targetLine?.[2] ? "patch" : "notice"
}

async function readState(file: string): Promise<UpdateState | undefined> {
  try {
    const state: unknown = JSON.parse(await readFile(file, "utf8"))
    if (!state || typeof state !== "object") return undefined
    const value = state as Partial<UpdateState>
    if (
      !Number.isFinite(value.checkedAt) ||
      (value.channel !== "stable" && value.channel !== "next") ||
      (value.available !== undefined &&
        (typeof value.available !== "string" || !parseVersion(value.available)))
    )
      return undefined
    return value as UpdateState
  } catch {
    return undefined
  }
}

async function saveState(file: string, state: UpdateState): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`)
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

function noticeFor(
  state: UpdateState | undefined,
  current: string,
  channel: UpdateChannel,
  minimum?: string,
) {
  if (belowMinimum(current, minimum)) {
    return `Amira ${current} is below the required version ${minimum}. Run amira update --channel ${channel}.`
  }
  if (
    state?.channel === channel &&
    state.available &&
    updatePolicy(current, state.available, minimum) === "notice"
  ) {
    return `Amira ${state.available} is available. Run amira update --channel ${channel}.`
  }
  return undefined
}

/** Reads cached notices first; only the returned task touches the network. All failures are silent. */
export async function startBackgroundUpdate(
  settings: Settings,
  options: BackgroundOptions = {},
): Promise<BackgroundUpdate> {
  const env = options.env ?? process.env
  const updater: UpdateEngine = options.updater ?? createUpdater()
  let stopping = false
  const stop = async () => {
    stopping = true
    await updater.stop?.().catch(() => {})
  }
  options.onStop?.(stop)
  // Protection is best effort: an update or an unwritable install must never prevent a
  // session from starting. Without a lease, skip this updater's pruning and auto-installation.
  try {
    await updater.pinVersion?.()
  } catch {
    return { finished: Promise.resolve(), stop }
  }
  try {
    // Local cleanup does not need a release key; the engine still verifies install ownership.
    const cleanup = options.checks === false ? Promise.resolve() : updater.cleanup().catch(() => {})
    if (
      options.checks === false ||
      (settings.updates?.auto ?? DEFAULT_UPDATE_AUTO) === false ||
      updateSwitch(env.AMIRA_DISABLE_AUTOUPDATE) ||
      updateSwitch(env.AMIRA_DISABLE_UPDATES) ||
      updateSwitch(env.AMIRA_OFFLINE) ||
      (await updater.disabledReason())
    )
      return { finished: cleanup, stop }
    const current = options.version ?? version
    const channel = updateChannel(settings.updates?.channel)
    const minimum = settings.updates?.minimumVersion
    const file = options.stateFile ?? amiraPath("state", "update.json")
    const now = options.now ?? Date.now
    const state = await readState(file)
    const notice = noticeFor(state, current, channel, minimum)
    const finished = (async () => {
      // Cleanup is local and best-effort even on a throttled start.
      await cleanup
      if (stopping) return
      await mkdir(path.dirname(file), { recursive: true })
      const lock = tryFileLock(`${file}.lock`, 10 * 60_000, 30_000, true)
      if (!lock) return
      try {
        const cached = await readState(file)
        const timestamp = now()
        if (
          cached?.channel === channel &&
          timestamp >= cached.checkedAt &&
          timestamp - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS
        )
          return
        // Persist before networking, so offline errors and failed downloads are throttled too.
        await saveState(file, {
          checkedAt: timestamp,
          channel,
          ...(cached?.channel === channel && cached.available ? { available: cached.available } : {}),
        })
        if (stopping) return
        const target = await updater.check(channel)
        if (stopping) return
        const policy = updatePolicy(current, target.version, minimum)
        if (policy === "patch") await updater.update(channel)
        await saveState(file, {
          checkedAt: timestamp,
          channel,
          ...(policy === "notice" ? { available: target.version } : {}),
        })
      } finally {
        lock.release()
      }
    })().catch(() => {})
    return { ...(notice ? { notice } : {}), finished, stop }
  } catch {
    return { finished: Promise.resolve(), stop }
  }
}

/** Plain print output may show notices only when stderr is a terminal, never JSON or RPC. */
export function printUpdateNotice(options: {
  print: boolean
  json: boolean
  rpc: boolean
  stderrTTY: boolean
}): boolean {
  return options.print && !options.json && !options.rpc && options.stderrTTY
}
