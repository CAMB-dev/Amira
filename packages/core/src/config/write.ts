import { mkdirSync, renameSync, writeFileSync } from "node:fs"
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
  const raw = readJsonFile(file) ?? {}
  if (!isPlainObject(raw)) throw new SettingsError(file, ["must hold a JSON object"])
  const providers = raw.providers ?? {}
  if (!isPlainObject(providers)) throw new SettingsError(file, ['"providers" must be an object'])
  if (providers[id] !== undefined) return "exists"
  writeJsonAtomic(file, { ...raw, providers: { ...providers, [id]: provider } })
  return "added"
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, file)
}
