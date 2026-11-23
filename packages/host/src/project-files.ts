import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { runCommand } from "@amira/proc"

/** Streams paths as they are found; resolves once the listing is over, false when it was cut short. */
export type ListFiles = (
  cwd: string,
  emit: (paths: string[]) => void,
  signal: AbortSignal,
) => Promise<unknown>

export interface ListOptions {
  /** Stop after this many paths. */
  limit?: number
  /** Stop listing after this long, git and a walk together. */
  timeoutMs?: number
  signal?: AbortSignal
}

/** Paths a project listing holds at most by default. */
export const MAX_FILES = 250_000

const LIST_TIMEOUT_MS = 15_000
const SKIP_DIRS = new Set([".git", "node_modules"])

/**
 * Streams the files under `cwd` to `emit`, as paths relative to it: from `git ls-files` (tracked
 * and untracked files, without what .gitignore ignores) in a repository, else from a walk of the
 * directory that skips .git and node_modules, like the glob tool. git runs in the command worker
 * and its output is handed over as it comes, so nothing here holds the event loop for long.
 * Resolves false when capped, cancelled, timed out, or otherwise unable to finish the listing.
 */
export async function streamProjectFiles(
  cwd: string,
  emit: (paths: string[]) => void,
  opts: ListOptions = {},
): Promise<boolean> {
  const limit = opts.limit ?? MAX_FILES
  const timeoutMs = opts.timeoutMs ?? LIST_TIMEOUT_MS
  const deadline = performance.now() + timeoutMs
  if (opts.signal?.aborted || performance.now() >= deadline) return false
  const abort = new AbortController()
  const signal = abort.signal
  const onAbort = () => abort.abort()
  opts.signal?.addEventListener("abort", onAbort, { once: true })
  let sent = 0
  let capped = false
  const send = (paths: string[]) => {
    if (signal.aborted || !paths.length) return
    if (performance.now() >= deadline) {
      abort.abort()
      return
    }
    const room = paths.length > limit - sent ? paths.slice(0, limit - sent) : paths
    capped = room.length < paths.length
    sent += room.length
    if (room.length) emit(room)
    // An exact fit may be complete. Only stop once another path proves it was cut short.
    if (capped) abort.abort()
  }
  try {
    const fromGit = await gitFiles(cwd, timeoutMs, signal, send)
    if (fromGit !== "none") return fromGit === "listed" && !capped && !signal.aborted
    // Some of git's output came before it failed: keep that rather than mixing in a walk.
    if (sent || signal.aborted || performance.now() >= deadline) return false
    return await walk(cwd, deadline, signal, send)
  } finally {
    opts.signal?.removeEventListener("abort", onAbort)
  }
}

/** The files under `cwd` in one list; see streamProjectFiles. */
export async function listProjectFiles(cwd: string, opts: ListOptions = {}): Promise<string[]> {
  const out: string[] = []
  await streamProjectFiles(cwd, (paths) => out.push(...paths), opts)
  return [...new Set(out)]
}

/**
 * Lists the files with git, paths going to `emit` while it runs: "listed" in a repository, "partial"
 * when it timed out, was cancelled, or failed after some output, "none" when it gave none.
 */
async function gitFiles(
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  emit: (paths: string[]) => void,
): Promise<"listed" | "partial" | "none"> {
  let any = false
  let rest = ""
  try {
    const run = await runCommand(
      ["git", "-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd,
        timeoutMs,
        signal,
        stdoutOnly: true,
        // Windows: Bun stalls for seconds on some direct spawns of git (see git.ts).
        viaCmd: true,
        onChunk: (chunk) => {
          const parts = (rest + chunk).split("\0")
          rest = parts.pop()!
          const paths = parts.filter(Boolean)
          if (paths.length) any = true
          emit(paths)
        },
      },
    )
    if (run.timedOut || run.aborted || !run.settled) return "partial"
    if (run.exitCode === 0) {
      if (rest) emit([rest])
      return "listed"
    }
  } catch {}
  return any || signal.aborted ? "partial" : "none"
}

/** Walks the tree depth first; false when capped, cancelled, timed out, or unreadable. */
async function walk(
  root: string,
  deadline: number,
  signal: AbortSignal,
  emit: (paths: string[]) => void,
): Promise<boolean> {
  const stack: string[] = [""]
  let complete = true
  while (stack.length && !signal.aborted && performance.now() < deadline) {
    const rel = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true })
    } catch {
      complete = false
      continue
    }
    if (signal.aborted || performance.now() >= deadline) return false
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
  return complete && !stack.length && !signal.aborted && performance.now() < deadline
}
