import type { Dirent } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

export const SKIP_DIRS = new Set([".git", "node_modules"])

/** A NUL byte in the first 8 KB marks a file as binary. */
export function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

export async function statOrNull(path: string) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

export interface WalkEntry {
  abs: string
  /** Forward-slash path relative to the walk root. */
  rel: string
}

/** Yields files under `root` in sorted order, skipping .git and node_modules. Symlinked dirs are not followed. */
export async function* walkFiles(root: string, signal?: AbortSignal): AsyncGenerator<WalkEntry> {
  const stack: [string, string][] = [[root, ""]]
  while (stack.length > 0) {
    if (signal?.aborted) return
    const [dir, prefix] = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const subdirs: [string, string][] = []
    for (const e of entries) {
      const abs = join(dir, e.name)
      const rel = prefix + e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) subdirs.push([abs, `${rel}/`])
      } else if (e.isFile()) {
        yield { abs, rel }
      } else if (e.isSymbolicLink() && (await statOrNull(abs))?.isFile()) {
        yield { abs, rel }
      }
    }
    stack.push(...subdirs.reverse())
  }
}
