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

/** Drops every cached module under `root`, so the next import evaluates those files again. */
export function forgetModulesUnder(root: string): void {
  const prefix = caseKey(path.resolve(root)) + path.sep
  for (const key of Object.keys(require.cache)) {
    if (caseKey(path.resolve(key)).startsWith(prefix)) delete require.cache[key]
  }
}
