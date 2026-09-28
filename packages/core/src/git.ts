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
export async function gitInfo(cwd: string, timeoutMs = 5000): Promise<GitInfo> {
  const [dirs, branch, head] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], timeoutMs),
    git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], timeoutMs),
    git(cwd, ["rev-parse", "--short", "HEAD"], timeoutMs),
  ])
  if (!dirs) return {}
  const [repoRoot, gitDir, commonDir] = dirs.split(/\r?\n/)
  const info: GitInfo = {}
  if (repoRoot) info.repoRoot = path.normalize(repoRoot)
  if (gitDir && commonDir) {
    // --git-common-dir may be relative to cwd.
    info.isWorktree = path.normalize(gitDir) !== path.resolve(cwd, commonDir)
  }
  if (branch) info.branch = branch
  if (head) info.head = head
  return info
}

/**
 * Emits workspace.changed in the background right away and after every turn,
 * but only when something changed, so git never delays startup or a turn.
 */
export function trackWorkspace(bus: EventBus, sessionId: string, cwd: string): () => void {
  let last = ""
  let stopped = false
  const check = async () => {
    const info = await gitInfo(cwd)
    const key = JSON.stringify(info)
    if (stopped || key === last) return
    last = key
    bus.emit("workspace.changed", { cwd, ...info }, { sessionId })
  }
  void check()
  const off = bus.subscribe(() => void check(), { types: ["turn.end"] })
  return () => {
    stopped = true
    off()
  }
}
