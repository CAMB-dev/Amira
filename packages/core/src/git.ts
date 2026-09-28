import { statSync } from "node:fs"
import path from "node:path"
import type { EventBus } from "./event-bus.ts"

export interface GitInfo {
  repoRoot?: string
  branch?: string
  head?: string
  isWorktree?: boolean
}

async function git(cwd: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  try {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" })
    const timer = setTimeout(() => p.kill(), timeoutMs)
    try {
      const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
      return code === 0 ? out.trim() : undefined
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return undefined
  }
}

/**
 * Best-effort git facts about cwd; every field is omitted when unknown. Works in
 * repositories without commits and with git versions back to 2.13. Paths use the
 * platform's separators.
 */
export async function gitInfo(cwd: string, timeoutMs = 15_000): Promise<GitInfo> {
  return (await probe(cwd, timeoutMs)).info
}

interface Probe {
  info: GitInfo
  gitDir?: string
  /** Where branch refs live; differs from gitDir in linked worktrees. */
  commonDir?: string
}

async function probe(cwd: string, timeoutMs: number): Promise<Probe> {
  const [dirs, branch, head] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], timeoutMs),
    git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], timeoutMs),
    git(cwd, ["rev-parse", "--short", "HEAD"], timeoutMs),
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
  return { info, ...(gitDir ? { gitDir } : {}), ...(commonDir ? { commonDir } : {}) }
}

const mtime = (p: string) => statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0

/**
 * Cheap fingerprint of HEAD, the current branch ref and packed refs, from file times only.
 * Repositories using the reftable format are not covered and are only probed at startup.
 */
function headStamp(p: Probe): string {
  if (!p.gitDir || !p.commonDir) return ""
  const branch = p.info.branch
  return [
    mtime(path.join(p.gitDir, "HEAD")),
    branch ? mtime(path.join(p.commonDir, "refs", "heads", ...branch.split("/"))) : 0,
    mtime(path.join(p.commonDir, "packed-refs")),
  ].join(":")
}

/** Whether cwd or one of its ancestors has a .git entry; a stat per level, no spawn. */
function insideRepo(cwd: string): boolean {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (statSync(path.join(dir, ".git"), { throwIfNoEntry: false })) return true
    if (path.dirname(dir) === dir) return false
  }
}

/**
 * Emits workspace.changed in the background shortly after startup, then again after a
 * turn only if HEAD, the branch ref or packed refs changed on disk, or a repository
 * appeared. Spawning git can stall the event loop for seconds on some Windows machines,
 * so it never runs on every turn.
 */
export function trackWorkspace(
  bus: EventBus,
  sessionId: string,
  cwd: string,
  opts: { initialDelayMs?: number } = {},
): () => void {
  let stopped = false
  let last: Probe | undefined
  let stamp = ""
  let checking = false
  const check = async () => {
    if (checking) return
    checking = true
    try {
      const p = await probe(cwd, 15_000)
      if (stopped) return
      last = p
      stamp = headStamp(p)
      bus.emit("workspace.changed", { cwd, ...p.info }, { sessionId })
    } finally {
      checking = false
    }
  }
  const timer = setTimeout(() => void check(), opts.initialDelayMs ?? 500)
  const off = bus.subscribe(
    () => {
      if (stopped || !last) return
      const changed = last.gitDir ? headStamp(last) !== stamp : insideRepo(cwd)
      if (changed) void check()
    },
    { types: ["turn.end"] },
  )
  return () => {
    stopped = true
    clearTimeout(timer)
    off()
  }
}
