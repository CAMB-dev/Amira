import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { runCommand } from "@amira/proc"

/**
 * The project's files and directories as far as they are known. While loading it grows in
 * place (the same `entries` array), so a search can go on where it stopped.
 */
export interface FileListing {
  /** Relative forward-slash paths of files, and of their directories with a trailing "/", in the order found. */
  readonly entries: readonly string[]
  /** How many of `entries` are files. */
  readonly files: number
  /** The listing is complete; it no longer grows. */
  readonly done: boolean
  /** It stopped at its cap: the project has more files than it holds. */
  readonly capped: boolean
}

/** Where the file picker gets the project's files. */
export interface FileSource {
  /** The listing to search now; starts loading it, or refreshing a stale one, as needed. Never waits. */
  listing(): FileListing
  /** Called when the listing grows or is replaced by a fresh one; returns a function that unsubscribes. */
  subscribe(listener: () => void): () => void
}

/** Streams paths as they are found; resolves once the listing is over. */
export type ListFiles = (cwd: string, emit: (paths: string[]) => void, signal: AbortSignal) => Promise<void>

export interface ListOptions {
  /** Stop after this many files. */
  limit?: number
  /** Give up on git after this long; a walk stops listing then too. */
  timeoutMs?: number
  signal?: AbortSignal
}

/** Files a listing holds at most; past it the picker searches the first ones and says so. */
export const MAX_FILES = 250_000

/** How long adding found paths to a listing may hold the event loop at a time. */
const ADD_SLICE_MS = 4

/** Listing a project runs off the input path, so it may take a while in a very large tree. */
const LIST_TIMEOUT_MS = 15_000

const SKIP_DIRS = new Set([".git", "node_modules"])

/**
 * Streams the files under `cwd` to `emit`, as paths relative to it: from `git ls-files` (tracked
 * and untracked files, without what .gitignore ignores) in a repository, else from a walk of the
 * directory that skips .git and node_modules, like the glob tool. git runs in the command worker
 * and its output is handed over as it comes, so nothing here holds the event loop for long.
 */
export async function streamProjectFiles(
  cwd: string,
  emit: (paths: string[]) => void,
  opts: ListOptions = {},
): Promise<void> {
  const limit = opts.limit ?? MAX_FILES
  const timeoutMs = opts.timeoutMs ?? LIST_TIMEOUT_MS
  const signal = opts.signal ?? new AbortController().signal
  let sent = 0
  const send = (paths: string[]) => {
    if (sent >= limit || !paths.length) return
    const room = paths.length > limit - sent ? paths.slice(0, limit - sent) : paths
    sent += room.length
    emit(room)
  }
  if (await gitFiles(cwd, timeoutMs, signal, send)) return
  if (sent) return
  await walk(cwd, performance.now() + timeoutMs, signal, send, () => sent >= limit)
}

/** The files under `cwd` in one list; see streamProjectFiles. */
export async function listProjectFiles(cwd: string, opts: ListOptions = {}): Promise<string[]> {
  const out: string[] = []
  await streamProjectFiles(cwd, (paths) => out.push(...paths), opts)
  return [...new Set(out)]
}

/** Whether git listed the files (a repository); paths go to `emit` while it runs. */
async function gitFiles(
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  emit: (paths: string[]) => void,
): Promise<boolean> {
  let rest = ""
  try {
    const run = await runCommand(
      ["git", "-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd,
        timeoutMs,
        signal,
        stdoutOnly: true,
        // Windows: Bun stalls for seconds on some direct spawns of git (see core's git.ts).
        viaCmd: true,
        onChunk: (chunk) => {
          const parts = (rest + chunk).split("\0")
          rest = parts.pop()!
          emit(parts.filter(Boolean))
        },
      },
    )
    if (run.exitCode !== 0) return false
    if (rest) emit([rest])
    return true
  } catch {
    return false
  }
}

async function walk(
  root: string,
  deadline: number,
  signal: AbortSignal,
  emit: (paths: string[]) => void,
  full: () => boolean,
): Promise<void> {
  const stack: string[] = [""]
  while (stack.length && !full() && !signal.aborted && performance.now() < deadline) {
    const rel = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const dirs: string[] = []
    const files: string[] = []
    for (const e of entries) {
      const p = rel + e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) dirs.push(`${p}/`)
      } else files.push(p)
    }
    emit(files)
    stack.push(...dirs.reverse())
  }
}

/**
 * A listing being filled: files are added with their directories, each directory once. A file
 * repeated right after itself (git lists a conflicted file once per stage) is added once; no
 * set of every file is kept, since growing one that big holds the event loop for milliseconds.
 */
class GrowingListing implements FileListing {
  readonly entries: string[] = []
  files = 0
  done = false
  capped = false
  /** The directories added. */
  #seen = new Set<string>()
  #lastFile: string | undefined
  /** The directory of the last file added: its neighbours in a sorted listing share it. */
  #lastDir = ""

  constructor(private limit: number) {}

  /** Adds `paths` from `from`, until `deadline` (performance.now()); returns where it stopped. */
  add(paths: string[], from = 0, deadline = Number.POSITIVE_INFINITY): number {
    let i = from
    while (i < paths.length) {
      if (this.files >= this.limit) {
        this.capped = true
        return paths.length
      }
      this.#addOne(paths[i++]!)
      if ((i & 255) === 0 && performance.now() >= deadline) break
    }
    return i
  }

  #addOne(p: string) {
    if (p === this.#lastFile) return
    this.#lastFile = p
    this.entries.push(p)
    this.files++
    const dirEnd = p.lastIndexOf("/") + 1
    if (!dirEnd) return
    if (dirEnd === this.#lastDir.length && p.startsWith(this.#lastDir)) return
    this.#lastDir = p.slice(0, dirEnd)
    for (let i = p.indexOf("/"); i !== -1; i = p.indexOf("/", i + 1)) {
      const dir = p.slice(0, i + 1)
      if (this.#seen.has(dir)) continue
      this.#seen.add(dir)
      this.entries.push(dir)
    }
  }

  finish() {
    this.done = true
    // Only needed while growing.
    this.#seen = new Set()
  }
}

export interface FileIndexOptions {
  /** How long a complete listing is used before a fresh one is loaded (in the background). */
  ttlMs?: number
  /** Files a listing holds at most. */
  limit?: number
  /** Where the paths come from; streamProjectFiles by default. */
  list?: ListFiles
}

/**
 * The project's files and directories, listed off the input path and kept for `ttlMs`. The first
 * listing is searchable while it loads; after `ttlMs` the old one is still answered at once
 * while a fresh one loads in the background and replaces it when complete. Typing never waits.
 */
export class FileIndex implements FileSource {
  #current: GrowingListing | undefined
  #next: GrowingListing | undefined
  #loadedAt = 0
  #listeners = new Set<() => void>()

  constructor(
    private cwd: string,
    private opts: FileIndexOptions = {},
  ) {}

  listing(): FileListing {
    if (!this.#current) {
      this.#current = this.#load(() => {})
      return this.#current
    }
    const stale = performance.now() - this.#loadedAt > (this.opts.ttlMs ?? 30_000)
    if (stale && this.#current.done && !this.#next) {
      this.#next = this.#load((fresh) => {
        this.#current = fresh
        this.#next = undefined
      })
    }
    return this.#current
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #notify() {
    for (const l of this.#listeners) l()
  }

  #load(onDone: (listing: GrowingListing) => void): GrowingListing {
    const limit = this.opts.limit ?? MAX_FILES
    const listing = new GrowingListing(limit)
    const abort = new AbortController()
    const shown = () => listing === this.#current
    // Paths come in bursts (a repository's whole listing at once); they are added in slices
    // between keys and frames, not as they arrive.
    const queue: string[][] = []
    let at = 0
    let listed = false
    let draining: ReturnType<typeof setImmediate> | undefined
    const end = () => {
      if (listing.done) return
      listing.finish()
      this.#loadedAt = performance.now()
      onDone(listing)
    }
    const drain = () => {
      draining = undefined
      const deadline = performance.now() + ADD_SLICE_MS
      while (queue.length && performance.now() < deadline) {
        at = listing.add(queue[0]!, at, deadline)
        if (at >= queue[0]!.length) {
          queue.shift()
          at = 0
        }
      }
      if (listing.capped) {
        queue.length = 0
        abort.abort()
      }
      if (queue.length) draining = setImmediate(drain)
      else if (listed) end()
      if (shown()) this.#notify()
    }
    const emit = (paths: string[]) => {
      if (listing.done || listing.capped || !paths.length) return
      queue.push(paths)
      draining ??= setImmediate(drain)
    }
    const list =
      this.opts.list ?? ((cwd, e, signal) => streamProjectFiles(cwd, e, { limit: limit + 1, signal }))
    list(this.cwd, emit, abort.signal)
      .catch(() => {})
      .then(() => {
        listed = true
        if (draining) return
        end()
        this.#notify()
      })
    return listing
  }
}

/** A source for a list known up front, or one promise of it (tests, other frontends). */
export function fileList(files: string[] | (() => string[] | Promise<string[]>)): FileSource {
  let listing: GrowingListing | undefined
  const listeners = new Set<() => void>()
  return {
    listing() {
      if (listing) return listing
      const l = new GrowingListing(Number.POSITIVE_INFINITY)
      listing = l
      const found = typeof files === "function" ? files() : files
      const fill = (paths: string[]) => {
        l.add(paths)
        l.finish()
      }
      if (Array.isArray(found)) fill(found)
      else
        void found
          .then(fill, () => l.finish())
          .then(() => {
            for (const f of listeners) f()
          })
      return l
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
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
