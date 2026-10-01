import { statSync } from "node:fs"
import path from "node:path"
import { runCommand } from "@amira/proc"
import type { EventBus } from "./event-bus.ts"

export interface GitInfo {
  repoRoot?: string
  branch?: string
  head?: string
  isWorktree?: boolean
  /** Changes not committed yet: staged, unstaged, or untracked files git does not ignore. */
  dirty?: boolean
}

/** Runs git off the main thread; a slow spawn must not freeze the UI. */
async function git(
  cwd: string,
  args: string[],
  timeoutMs: number,
  env?: Record<string, string | undefined>,
): Promise<string | undefined> {
  try {
    const run = await runCommand(["git", ...args], {
      cwd,
      timeoutMs,
      signal: new AbortController().signal,
      stdoutOnly: true,
      // Windows: Bun stalls for seconds on some direct spawns of git.
      viaCmd: true,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    })
    return run.exitCode === 0 ? run.output.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Best-effort git facts about cwd; every field is omitted when unknown. Works in
 * repositories without commits and with git versions back to 2.13. Paths use the
 * platform's separators.
 */
export async function gitInfo(
  cwd: string,
  timeoutMs = 15_000,
  opts: { dirty?: boolean } = {},
): Promise<GitInfo> {
  return (await probe(cwd, timeoutMs, opts.dirty ?? false)).info
}

interface Probe {
  info: GitInfo
  gitDir?: string
  /** Where branch refs live; differs from gitDir in linked worktrees. */
  commonDir?: string
}

/**
 * Whether the working tree has changes not committed yet; undefined when git cannot tell. It
 * takes no optional locks (the index refresh), so it never gets in the way of a `git commit`
 * running meanwhile, and leaves the index as it was. Submodules' own changes are left out:
 * they would make git walk every submodule.
 */
async function dirtyOf(cwd: string, timeoutMs: number): Promise<boolean | undefined> {
  const out = await git(
    cwd,
    ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=dirty"],
    timeoutMs,
    { GIT_OPTIONAL_LOCKS: "0" },
  )
  return out === undefined ? undefined : out !== ""
}

async function probe(cwd: string, timeoutMs: number, withDirty: boolean): Promise<Probe> {
  const [dirs, branch, head, dirty] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], timeoutMs),
    git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], timeoutMs),
    git(cwd, ["rev-parse", "--short", "HEAD"], timeoutMs),
    withDirty ? dirtyOf(cwd, timeoutMs) : undefined,
  ])
  if (!dirs) return { info: {} }
  const [repoRoot, rawGitDir, rawCommonDir] = dirs.split(/\r?\n/)
  const info: GitInfo = {}
  if (repoRoot) info.repoRoot = path.normalize(repoRoot)
  const gitDir = rawGitDir ? path.normalize(rawGitDir) : undefined
  // --git-common-dir may be relative to cwd.
  const commonDir = rawCommonDir ? path.resolve(cwd, rawCommonDir) : gitDir
  if (gitDir && commonDir) info.isWorktree = gitDir !== commonDir
  if (branch) info.branch = branch
  if (head) info.head = head
  if (dirty !== undefined) info.dirty = dirty
  return { info, ...(gitDir ? { gitDir } : {}), ...(commonDir ? { commonDir } : {}) }
}

const mtime = (p: string) => statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0

/**
 * Cheap fingerprint of HEAD, the current branch ref, packed refs and the index, from file
 * times only. Repositories using the reftable format are not covered for refs: their branch
 * changes show from the next startup.
 */
function headStamp(p: Probe): string {
  if (!p.gitDir || !p.commonDir) return ""
  const branch = p.info.branch
  return [
    mtime(path.join(p.gitDir, "HEAD")),
    branch ? mtime(path.join(p.commonDir, "refs", "heads", ...branch.split("/"))) : 0,
    mtime(path.join(p.commonDir, "packed-refs")),
    // Staging, committing, stashing or checking files out elsewhere writes the index.
    mtime(path.join(p.gitDir, "index")),
  ].join(":")
}

/** Whether cwd or one of its ancestors has a .git entry; a stat per level, no spawn. */
function insideRepo(cwd: string): boolean {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (statSync(path.join(dir, ".git"), { throwIfNoEntry: false })) return true
    if (path.dirname(dir) === dir) return false
  }
}

/** After this long without a check, a turn's end checks for changes even if nothing hints at one. */
const DIRTY_STALE_MS = 60_000

/**
 * Emits workspace.changed in the background shortly after startup, then again when the facts
 * change. After a turn, HEAD, the branch ref, packed refs or the index changed on disk (or a
 * repository appeared) probe everything again; otherwise only whether the working tree has
 * changes is checked (one spawn), after a turn that ran a tool which may have written files
 * (any but the built-in readers; also a sub-agent's) or when the last check is a minute old,
 * which catches edits made outside Amira. Spawning git can stall the event loop for seconds on
 * some Windows machines, so it runs in the background and never on every turn.
 */
export function trackWorkspace(
  bus: EventBus,
  sessionId: string,
  cwd: string,
  opts: { initialDelayMs?: number; staleMs?: number } = {},
): () => void {
  const staleMs = opts.staleMs ?? DIRTY_STALE_MS
  let stopped = false
  let last: Probe | undefined
  let emitted = ""
  let stamp = ""
  let checkedAt = 0
  let checking = false
  /** Asked again while a check ran: it runs once more after that one, full if either was. */
  let again: "full" | "dirty" | undefined
  /** A tool that may write files ran since the last check. */
  let wrote = false
  const check = async (kind: "full" | "dirty") => {
    if (checking) {
      again = again === "full" || kind === "full" ? "full" : "dirty"
      return
    }
    checking = true
    wrote = false
    try {
      let p: Probe
      if (kind === "dirty" && last?.gitDir) {
        const dirty = await dirtyOf(cwd, 15_000)
        const { dirty: _, ...rest } = last.info
        p = { ...last, info: dirty === undefined ? rest : { ...rest, dirty } }
      } else p = await probe(cwd, 15_000, true)
      if (stopped) return
      last = p
      checkedAt = Date.now()
      stamp = headStamp(p)
      const facts = JSON.stringify(p.info)
      if (facts === emitted) return
      emitted = facts
      bus.emit("workspace.changed", { cwd, ...p.info }, { sessionId })
    } finally {
      checking = false
      const next = again
      again = undefined
      if (next && !stopped) void check(next)
    }
  }
  const timer = setTimeout(() => void check("full"), opts.initialDelayMs ?? 500)
  const off = bus.subscribe(
    (e) => {
      if (stopped) return
      if (e.type === "tool.execute.end") {
        // Only an explicit no-write capability can skip a refresh; unknown tools stay safe.
        if (e.data.traits?.writesFiles !== false) wrote = true
        return
      }
      if (!last) return
      if (last.gitDir ? headStamp(last) !== stamp : insideRepo(cwd)) void check("full")
      else if (last.gitDir && (wrote || Date.now() - checkedAt >= staleMs)) void check("dirty")
    },
    { types: ["turn.end", "tool.execute.end"] },
  )
  return () => {
    stopped = true
    clearTimeout(timer)
    off()
  }
}
