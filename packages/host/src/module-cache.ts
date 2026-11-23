import { realpathSync } from "node:fs"
import path from "node:path"

/**
 * Forgets cached modules of extension packages before their entries are imported again. A
 * package is forgotten once per reload — when one of its entries comes round a second time —
 * so its other entries share the fresh modules of that load rather than each getting a copy.
 */
export class PackageModules {
  #entries = new Map<string, Set<string>>()

  beforeImport(root: string, entry: string): void {
    const key = caseKey(path.resolve(root))
    const seen = this.#entries.get(key) ?? new Set<string>()
    this.#entries.set(key, seen)
    if (seen.has(caseKey(entry))) {
      forgetModulesUnder(root)
      seen.clear()
    }
    seen.add(caseKey(entry))
  }
}

function caseKey(file: string): string {
  return process.platform === "win32" ? file.toLowerCase() : file
}

/**
 * Drops every cached module under `root`, so the next import evaluates those files again.
 * Cache keys are real paths (macOS temp directories sit behind a /var symlink), so both sides
 * are compared resolved.
 */
export function forgetModulesUnder(root: string): void {
  const prefixes = [path.resolve(root), real(root)].map((dir) => caseKey(dir) + path.sep)
  for (const key of Object.keys(require.cache)) {
    const file = caseKey(path.resolve(key))
    if (prefixes.some((prefix) => file.startsWith(prefix))) delete require.cache[key]
  }
}

function real(file: string): string {
  try {
    return realpathSync.native(file)
  } catch {
    return path.resolve(file)
  }
}

/** Drops one cached module under both its given and its real path (macOS /var -> /private/var). */
export function forgetModule(file: string): void {
  delete require.cache[file]
  delete require.cache[real(file)]
}
