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

async function probe(cwd: string, timeoutMs: number): Promise<{ info: GitInfo; gitDir?: string }> {
  const [dirs, branch, head] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], timeoutMs),
    git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], timeoutMs),
    git(cwd, ["rev-parse", "--short", "HEAD"], timeoutMs),
  ])
  if (!dirs) return { info: {} }
  const [repoRoot, gitDir, commonDir] = dirs.split(/\r?\n/)
  const info: GitInfo = {}
  if (repoRoot) info.repoRoot = path.normalize(repoRoot)
  if (gitDir && commonDir) {
    // --git-common-dir may be relative to cwd.
    info.isWorktree = path.normalize(gitDir) !== path.resolve(cwd, commonDir)
  }
  if (branch) info.branch = branch
  if (head) info.head = head
  return gitDir ? { info, gitDir: path.normalize(gitDir) } : { info }
}

/** Cheap fingerprint of HEAD and the current branch ref, from file times only. */
function headStamp(gitDir: string, branch: string | undefined): string {
  const mtime = (p: string) => statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0
  return `${mtime(path.join(gitDir, "HEAD"))}:${branch ? mtime(path.join(gitDir, "refs", "heads", branch)) : 0}`
}

/**
 * Emits workspace.changed in the background shortly after startup, then again after a
 * turn only if HEAD or the branch ref changed on disk. Spawning git can stall the event
 * loop for seconds on some Windows machines, so it never runs on every turn.
 */
export function trackWorkspace(
  bus: EventBus,
  sessionId: string,
  cwd: string,
  opts: { initialDelayMs?: number } = {},
): () => void {
  let stopped = false
  let gitDir: string | undefined
  let stamp = ""
  let branch: string | undefined
  const check = async () => {
    const { info, gitDir: dir } = await probe(cwd, 15_000)
    if (stopped) return
    gitDir = dir
    branch = info.branch
    if (gitDir) stamp = headStamp(gitDir, branch)
    bus.emit("workspace.changed", { cwd, ...info }, { sessionId })
  }
  const timer = setTimeout(() => void check(), opts.initialDelayMs ?? 500)
  const off = bus.subscribe(
    () => {
      if (!gitDir || stopped) return
      if (headStamp(gitDir, branch) !== stamp) void check()
    },
    { types: ["turn.end"] },
  )
  return () => {
    stopped = true
    clearTimeout(timer)
    off()
  }
}
