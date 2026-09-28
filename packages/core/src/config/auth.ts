import { statSync } from "node:fs"
import path from "node:path"
import { amiraHome } from "../home.ts"
import { readJsonFile } from "./load.ts"
import { validateAuth } from "./schema.ts"

export interface LoadedAuth {
  /** API keys by provider id. Environment variables win over these (D54). */
  keys: Record<string, string>
  warnings: string[]
}

export function authFile(home = amiraHome()): string {
  return path.join(home, "auth.json")
}

/**
 * Reads auth.json: `{"<provider>": {"apiKey": "..."}}`. A missing file means no keys. On
 * POSIX systems a file others can read is reported; Windows ACLs are not checked.
 */
export function loadAuth(file = authFile(), platform: string = process.platform): LoadedAuth {
  const raw = readJsonFile(file)
  if (raw === undefined) return { keys: {}, warnings: [] }
  const { keys, warnings } = validateAuth(raw, file)
  if (platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
    warnings.push(`${file} can be read by other users; run: chmod 600 "${file}"`)
  }
  return { keys, warnings }
}
