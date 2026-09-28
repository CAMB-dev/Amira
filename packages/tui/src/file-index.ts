import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { runCommand } from "@amira/proc"

/** Where the file picker gets the project's files; relative forward-slash paths, at once when known. */
export interface FileSource {
  files(): string[] | Promise<string[]>
}

export interface ListOptions {
  /** Stop after this many files. */
  limit?: number
  /** Give up on git after this long; a walk stops listing then too. */
  timeoutMs?: number
}

const SKIP_DIRS = new Set([".git", "node_modules"])

/**
 * The files under `cwd`, as paths relative to it: from `git ls-files` (tracked and untracked
 * files, without what .gitignore ignores) in a repository, else from a walk of the directory that
 * skips .git and node_modules, like the glob tool. Capped and time-limited for big trees.
 */
export async function listProjectFiles(cwd: string, opts: ListOptions = {}): Promise<string[]> {
  const limit = opts.limit ?? 100_000
  const timeoutMs = opts.timeoutMs ?? 5000
  const fromGit = await gitFiles(cwd, timeoutMs)
  if (fromGit) return fromGit.slice(0, limit)
  return walk(cwd, limit, performance.now() + timeoutMs)
}

async function gitFiles(cwd: string, timeoutMs: number): Promise<string[] | undefined> {
  try {
    const run = await runCommand(
      ["git", "-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd,
        timeoutMs,
        signal: new AbortController().signal,
        stdoutOnly: true,
        // Windows: Bun stalls for seconds on some direct spawns of git (see core's git.ts).
        viaCmd: true,
      },
    )
    if (run.exitCode !== 0) return undefined
    return [...new Set(run.output.split("\0").filter(Boolean))]
  } catch {
    return undefined
  }
}

async function walk(root: string, limit: number, deadline: number): Promise<string[]> {
  const out: string[] = []
  const stack: string[] = [""]
  while (stack.length && out.length < limit && performance.now() < deadline) {
    const rel = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const dirs: string[] = []
    for (const e of entries) {
      const p = rel + e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) dirs.push(`${p}/`)
      } else if (out.length < limit) out.push(p)
    }
    stack.push(...dirs.reverse())
  }
  return out
}

/**
 * The project's files and directories (with a trailing "/"), listed once and kept for `ttlMs`.
 * After that the old list is still answered at once while a fresh one loads in the background,
 * so typing is never held up by a big repository.
 */
export class FileIndex implements FileSource {
  #list: string[] | undefined
  #loadedAt = 0
  #loading: Promise<string[]> | undefined

  constructor(
    private cwd: string,
    private opts: { ttlMs?: number; list?: (cwd: string) => Promise<string[]> } = {},
  ) {}

  /** The list at once once loaded (refreshing it in the background when stale), else a promise of it. */
  files(): string[] | Promise<string[]> {
    const stale = performance.now() - this.#loadedAt > (this.opts.ttlMs ?? 30_000)
    if (this.#list && !stale) return this.#list
    const loading = this.#load()
    return this.#list ?? loading
  }

  #load(): Promise<string[]> {
    this.#loading ??= (this.opts.list ?? listProjectFiles)(this.cwd)
      .then(withDirectories, () => [] as string[])
      .then((list) => {
        this.#list = list
        this.#loadedAt = performance.now()
        this.#loading = undefined
        return list
      })
    return this.#loading
  }
}

/** Adds each directory of the files once, as "dir/", after them. */
export function withDirectories(files: string[]): string[] {
  const dirs = new Set<string>()
  for (const f of files) {
    for (let i = f.indexOf("/"); i !== -1; i = f.indexOf("/", i + 1)) dirs.add(f.slice(0, i + 1))
  }
  return [...files, ...dirs]
}
