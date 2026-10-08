import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ProviderSettings } from "@amira/api"
import { type FileLock, tryFileLock } from "../file-lock.ts"
import { readJsonFile } from "./load.ts"
import { isPlainObject } from "./merge.ts"
import { SettingsError } from "./schema.ts"

/**
 * Adds a provider to a settings file, keeping everything else in it. An existing entry
 * with the same id is left alone; the result says whether anything was written.
 */
export function addProviderToSettings(
  file: string,
  id: string,
  provider: ProviderSettings,
): "added" | "exists" {
  return withLock(file, () => {
    const raw = readJsonFile(file) ?? {}
    if (!isPlainObject(raw)) throw new SettingsError(file, ["must hold a JSON object"])
    const providers = raw.providers ?? {}
    if (!isPlainObject(providers)) throw new SettingsError(file, ['"providers" must be an object'])
    if (providers[id] !== undefined) return "exists"
    writeJsonAtomic(file, { ...raw, providers: { ...providers, [id]: provider } })
    return "added"
  })
}

/**
 * Changes one provider of a settings file under its lock, keeping everything else: `change`
 * gets the entry (undefined when there is none) and returns the new one, or undefined to
 * remove it. Nothing is written when it returns the entry unchanged.
 */
export function updateProviderInSettings(
  file: string,
  id: string,
  change: (current: ProviderSettings | undefined) => ProviderSettings | undefined,
): { before?: ProviderSettings; after?: ProviderSettings } {
  return withLock(file, () => {
    const raw = readJsonFile(file) ?? {}
    if (!isPlainObject(raw)) throw new SettingsError(file, ["must hold a JSON object"])
    const providers = raw.providers ?? {}
    if (!isPlainObject(providers)) throw new SettingsError(file, ['"providers" must be an object'])
    const before = providers[id] as ProviderSettings | undefined
    const after = change(before === undefined ? undefined : structuredClone(before))
    const result = { ...(before ? { before } : {}), ...(after ? { after } : {}) }
    if (JSON.stringify(after) === JSON.stringify(before)) return result
    const next: Record<string, unknown> = { ...providers }
    if (after === undefined) delete next[id]
    else next[id] = after
    writeJsonAtomic(file, { ...raw, providers: next })
    return result
  })
}

/**
 * Changes a settings file under its lock, keeping everything `change` leaves alone: it gets
 * the parsed object ({} for a missing file) and returns the new one. Nothing is written when
 * the result is the same. Returns whether the file changed.
 */
export function updateSettingsFile(
  file: string,
  change: (current: Record<string, unknown>) => Record<string, unknown>,
): boolean {
  mkdirSync(path.dirname(file), { recursive: true })
  return withLock(file, () => {
    const raw = readJsonFile(file) ?? {}
    if (!isPlainObject(raw)) throw new SettingsError(file, ["must hold a JSON object"])
    const next = change(structuredClone(raw))
    if (JSON.stringify(next) === JSON.stringify(raw)) return false
    writeJsonAtomic(file, next)
    return true
  })
}

/**
 * Stores (or with undefined, removes) a provider's API key in auth.json under its lock,
 * keeping the other entries. On POSIX systems the file is only readable by its owner; see
 * restrictToCurrentUser for Windows. Returns whether the file changed.
 */
export function setAuthKey(file: string, id: string, apiKey: string | undefined): boolean {
  return withLock(file, () => {
    const raw = readJsonFile(file) ?? {}
    if (!isPlainObject(raw)) throw new SettingsError(file, ["must hold a JSON object"])
    const exists = Object.hasOwn(raw, id)
    const current = exists ? raw[id] : undefined
    const next: Record<string, unknown> = { ...raw }
    if (apiKey === undefined) {
      if (current === undefined) return false
      delete next[id]
    } else {
      if (exists && (!isPlainObject(current) || (current.type !== undefined && current.type !== "api_key"))) {
        throw new SettingsError(file, [
          `cannot set API key for provider "${id}": existing auth entry has an unsupported type`,
        ])
      }
      if (isPlainObject(current) && current.type === "api_key" && current.apiKey === apiKey) return false
      next[id] = { ...(isPlainObject(current) ? current : {}), type: "api_key", apiKey }
    }
    writeJsonAtomic(file, next, 0o600)
    return true
  })
}

/** Holds `<file>.lock` while `fn` runs, so two writers cannot drop each other's change. */
function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`
  let held: FileLock | undefined
  try {
    held = tryFileLock(lock, STALE_LOCK_MS)
  } catch (err) {
    throw new SettingsError(file, [`cannot be locked: ${err instanceof Error ? err.message : String(err)}`])
  }
  if (!held) {
    throw new SettingsError(file, [
      `is being changed by another amira process; if none is running, delete ${lock}`,
    ])
  }
  try {
    return fn()
  } finally {
    held.release()
  }
}

/** A write takes milliseconds, so an older lock was left by a process that died. */
const STALE_LOCK_MS = 10_000

function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, mode !== undefined ? { mode } : {})
  // The mode given to writeFileSync only applies to a new file, and the umask may cut it.
  if (mode !== undefined && process.platform !== "win32") chmodSync(tmp, mode)
  try {
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    const why = err instanceof Error ? err.message : String(err)
    throw new SettingsError(file, [`cannot be replaced (is it open in another program?): ${why}`])
  }
}
