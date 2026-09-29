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
async function git(cwd: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  try {
    const run = await runCommand(["git", ...args], {
      cwd,
      timeoutMs,
      signal: new AbortController().signal,
      stdoutOnly: true,
      // Windows: Bun stalls for seconds on some direct spawns of git.
      viaCmd: true,
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

async function probe(cwd: string, timeoutMs: number, withDirty: boolean): Promise<Probe> {
  const [dirs, branch, head, status] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], timeoutMs),
    git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], timeoutMs),
    git(cwd, ["rev-parse", "--short", "HEAD"], timeoutMs),
    // Submodules' own changes are left out: they would make git walk every submodule.
    withDirty
      ? git(
          cwd,
          ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=dirty"],
          timeoutMs,
        )
      : undefined,
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
  if (status !== undefined) info.dirty = status !== ""
  return { info, ...(gitDir ? { gitDir } : {}), ...(commonDir ? { commonDir } : {}) }
}

const mtime = (p: string) => statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0

/**
 * Cheap fingerprint of HEAD, the current branch ref, packed refs and the index, from file
 * times only. Repositories using the reftable format are not covered for refs, and are only
 * probed at startup and after turns that ran tools.
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

/** Built-in tools that only read files: a turn that ran nothing else changed no file. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob"])

/** Whether cwd or one of its ancestors has a .git entry; a stat per level, no spawn. */
function insideRepo(cwd: string): boolean {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (statSync(path.join(dir, ".git"), { throwIfNoEntry: false })) return true
    if (path.dirname(dir) === dir) return false
  }
}

/**
 * Emits workspace.changed in the background shortly after startup, then again when the facts
 * change: checked after a turn that ran a tool which may have written files (any but the
 * built-in readers; also a sub-agent's), and after any turn when HEAD, the branch ref, packed
 * refs or the index changed on disk, or a repository appeared. Spawning git can stall the
 * event loop for seconds on some Windows machines, so it runs in the background and never on
 * every turn.
 */
export function trackWorkspace(
  bus: EventBus,
  sessionId: string,
  cwd: string,
  opts: { initialDelayMs?: number } = {},
): () => void {
  let stopped = false
  let last: Probe | undefined
  let emitted = ""
  let stamp = ""
  let checking = false
  /** Asked again while a check ran: it runs once more after that one. */
  let again = false
  /** A tool that may write files ran since the last check. */
  let wrote = false
  const check = async () => {
    if (checking) {
      again = true
      return
    }
    checking = true
    wrote = false
    try {
      const p = await probe(cwd, 15_000, true)
      if (stopped) return
      last = p
      // Taken after the probe: git status may itself refresh the index.
      stamp = headStamp(p)
      const facts = JSON.stringify(p.info)
      if (facts === emitted) return
      emitted = facts
      bus.emit("workspace.changed", { cwd, ...p.info }, { sessionId })
    } finally {
      checking = false
      if (again && !stopped) {
        again = false
        void check()
      }
    }
  }
  const timer = setTimeout(() => void check(), opts.initialDelayMs ?? 500)
  const off = bus.subscribe(
    (e) => {
      if (stopped) return
      if (e.type === "tool.execute.end") {
        if (!READ_ONLY_TOOLS.has(e.data.name)) wrote = true
        return
      }
      if (!last) return
      const changed = wrote || (last.gitDir ? headStamp(last) !== stamp : insideRepo(cwd))
      if (changed) void check()
    },
    { types: ["turn.end", "tool.execute.end"] },
  )
  return () => {
    stopped = true
    clearTimeout(timer)
    off()
  }
}
