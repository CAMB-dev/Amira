import { type ListFiles, MAX_FILES, streamProjectFiles } from "@amira/core"

export {
  type ListFiles,
  type ListOptions,
  listProjectFiles,
  MAX_FILES,
  streamProjectFiles,
} from "@amira/core"

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
  /** It stopped short, at its cap or its time limit: the project has more files than it holds. */
  readonly partial: boolean
}

/** Where the file picker gets the project's files. */
export interface FileSource {
  /** The listing to search now; starts loading it, or refreshing a stale one, as needed. Never waits. */
  listing(): FileListing
  /** Called when the listing grows or is replaced by a fresh one; returns a function that unsubscribes. */
  subscribe(listener: () => void): () => void
  /** Stops listing; the UI is quitting. */
  dispose?(): void
}

/** How long adding found paths to a listing may hold the event loop at a time. */
const ADD_SLICE_MS = 4

/**
 * A listing being filled: files are added with their directories, each directory once. A file
 * repeated right after itself (git lists a conflicted file once per stage) is added once; no
 * set of every file is kept, since growing one that big holds the event loop for milliseconds.
 */
class GrowingListing implements FileListing {
  readonly entries: string[] = []
  files = 0
  done = false
  partial = false
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
        this.partial = true
        return paths.length
      }
      this.#addOne(paths[i++]!)
      if ((i & 255) === 0 && performance.now() >= deadline) break
    }
    return i
  }

  #addOne(p: string) {
    // git lists an untracked repository inside this one as its directory.
    if (p.endsWith("/")) return this.#addDirs(p, p.length)
    if (p === this.#lastFile) return
    this.#lastFile = p
    this.entries.push(p)
    this.files++
    const dirEnd = p.lastIndexOf("/") + 1
    if (!dirEnd) return
    if (dirEnd === this.#lastDir.length && p.startsWith(this.#lastDir)) return
    this.#lastDir = p.slice(0, dirEnd)
    this.#addDirs(p, dirEnd)
  }

  /** Adds the directories of `p` up to `end`, each once. */
  #addDirs(p: string, end: number) {
    for (let i = p.indexOf("/"); i !== -1 && i < end; i = p.indexOf("/", i + 1)) {
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
  /** Listings loading now, to stop on dispose. */
  #loads = new Set<AbortController>()
  #disposed = false

  constructor(
    private cwd: string,
    private opts: FileIndexOptions = {},
  ) {}

  /** Stops the listings loading (the UI is quitting); it tells no one of changes after. */
  dispose(): void {
    this.#disposed = true
    this.#listeners.clear()
    for (const a of this.#loads) a.abort()
  }

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
    this.#loads.add(abort)
    const shown = () => listing === this.#current
    // Paths come in bursts (a repository's whole listing at once); they are added in slices
    // between keys and frames, not as they arrive.
    const queue: string[][] = []
    let at = 0
    let listed = false
    /** The listing ended before it was complete (its time ran out). */
    let cut = false
    let draining: ReturnType<typeof setImmediate> | undefined
    const end = () => {
      if (listing.done) return
      if (cut) listing.partial = true
      listing.finish()
      this.#loadedAt = performance.now()
      onDone(listing)
    }
    const drain = () => {
      draining = undefined
      if (this.#disposed) return
      const deadline = performance.now() + ADD_SLICE_MS
      while (queue.length && performance.now() < deadline) {
        at = listing.add(queue[0]!, at, deadline)
        if (at >= queue[0]!.length) {
          queue.shift()
          at = 0
        }
      }
      if (listing.partial) {
        queue.length = 0
        abort.abort()
      }
      if (queue.length) draining = setImmediate(drain)
      else if (listed) end()
      if (shown()) this.#notify()
    }
    const emit = (paths: string[]) => {
      if (listing.done || listing.partial || !paths.length) return
      queue.push(paths)
      draining ??= setImmediate(drain)
    }
    const list =
      this.opts.list ?? ((cwd, e, signal) => streamProjectFiles(cwd, e, { limit: limit + 1, signal }))
    list(this.cwd, emit, abort.signal)
      .then(
        (complete) => {
          cut = complete === false
        },
        () => {
          cut = true
        },
      )
      .then(() => {
        this.#loads.delete(abort)
        listed = true
        if (draining || this.#disposed) return
        end()
        this.#notify()
      })
    return listing
  }
}

/**
 * A source for a list of files known up front, or one promise of it (tests, other frontends).
 * Like FileIndex it adds their directories, with a trailing "/".
 */
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
