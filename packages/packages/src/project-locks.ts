import {
  closeSync,
  type Dirent,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs"
import path from "node:path"
import { amiraHome } from "@amira/core"
import { packageScope } from "./lock.ts"

/** There is no project registry: trust decisions and session headers record visited paths. */
export function knownProjectLocks(where: { home?: string; cwd: string }): Set<string> {
  const home = where.home ?? amiraHome()
  const roots = new Set([path.resolve(where.cwd)])
  try {
    const packages = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"))?.packages
    for (const list of [packages?.trustedProjects, packages?.untrustedProjects]) {
      if (Array.isArray(list))
        for (const dir of list)
          if (typeof dir === "string" && path.isAbsolute(dir)) roots.add(path.resolve(dir))
    }
  } catch {}
  for (const { dir, entries } of directories(path.join(home, "sessions"))) {
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      const cwd = sessionCwd(path.join(dir, entry.name))
      if (cwd) roots.add(path.resolve(cwd))
    }
  }
  const locks = new Set([packageScope("user", { home, cwd: where.cwd }).lockFile])
  const seen = new Set<string>()
  for (const root of roots) {
    // The current path may not exist yet; still check its exact project lock.
    locks.add(packageScope("project", { home, cwd: root }).lockFile)
    for (const { dir, entries } of directories(root, seen))
      if (entries.some((entry) => entry.name === ".amira" && entry.isDirectory()))
        locks.add(packageScope("project", { home, cwd: dir }).lockFile)
  }
  return locks
}

/**
 * How far below a recorded path to look for nested projects, and how many directories to read in
 * all: a session started in a home or drive root must not make every prune walk the whole disk.
 */
const MAX_DEPTH = 4
const MAX_DIRECTORIES = 20_000

/** Resolve recorded roots, but do not follow other links or search dependency and git stores. */
function* directories(root: string, seen = new Set<string>()): Generator<{ dir: string; entries: Dirent[] }> {
  let resolved: string
  try {
    resolved = realpathSync(root)
  } catch {
    return
  }
  const pending: [string, number][] = [[resolved, 0]]
  while (pending.length && seen.size < MAX_DIRECTORIES) {
    const [dir, depth] = pending.pop()!
    const key = process.platform === "win32" ? dir.toLowerCase() : dir
    if (seen.has(key)) continue
    seen.add(key)
    let entries: Dirent[]
    try {
      const stat = lstatSync(dir)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    yield { dir, entries }
    if (depth >= MAX_DEPTH) continue
    for (const entry of entries)
      if (entry.isDirectory() && ![".amira", ".git", "node_modules"].includes(entry.name))
        pending.push([path.join(dir, entry.name), depth + 1])
  }
}

/** Read only the first line, not a session's potentially large message history. */
function sessionCwd(file: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(file, "r")
    const chunks: Buffer[] = []
    for (;;) {
      const chunk = Buffer.alloc(4096)
      const size = readSync(fd, chunk, 0, chunk.length, null)
      if (!size) break
      const end = chunk.subarray(0, size).indexOf(10)
      chunks.push(chunk.subarray(0, end < 0 ? size : end))
      if (end >= 0) break
    }
    const header = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (header?.type === "session" && typeof header.cwd === "string" && path.isAbsolute(header.cwd))
      return header.cwd
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return undefined
}
