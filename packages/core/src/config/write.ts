import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ProviderSettings } from "@amira/api"
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

/** Holds `<file>.lock` while `fn` runs, so two writers cannot drop each other's change. */
function withLock<T>(file: string, fn: () => T): T {
  mkdirSync(path.dirname(file), { recursive: true })
  const lock = `${file}.lock`
  let fd: number
  try {
    fd = openSync(lock, "wx")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    throw new SettingsError(file, [
      `is being changed by another amira process; if none is running, delete ${lock}`,
    ])
  }
  try {
    return fn()
  } finally {
    closeSync(fd)
    rmSync(lock, { force: true })
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  try {
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    const why = err instanceof Error ? err.message : String(err)
    throw new SettingsError(file, [`cannot be replaced (is it open in another program?): ${why}`])
  }
}
