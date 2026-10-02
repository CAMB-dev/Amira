import path from "node:path"
import { runCommand } from "@amira/proc"
import type { EventBus } from "./event-bus.ts"
import { type WorkspaceOptions, workspaceFor } from "./workspace.ts"

export interface GitInfo {
  repoRoot?: string
  branch?: string
  head?: string
  isWorktree?: boolean
  /** Changes not committed yet: staged, unstaged, or untracked files git does not ignore. */
  dirty?: boolean
}

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
 * Best-effort git facts about cwd; every field is omitted when unknown.
 *
 * @deprecated Workspace facts come from the workspace provider (the built-in agent extension
 * probes git) through `workspace.changed`. This one-shot probe stays standalone so existing
 * callers keep their results; it is removed together with the export.
 */
export async function gitInfo(
  cwd: string,
  timeoutMs = 15_000,
  opts: { dirty?: boolean } = {},
): Promise<GitInfo> {
  const [dirs, branch, head, status] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], timeoutMs),
    git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], timeoutMs),
    git(cwd, ["rev-parse", "--short", "HEAD"], timeoutMs),
    opts.dirty
      ? git(
          cwd,
          ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=dirty"],
          timeoutMs,
          { GIT_OPTIONAL_LOCKS: "0" },
        )
      : undefined,
  ])
  if (!dirs) return {}
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
  return info
}

/**
 * @deprecated The host tracks the active top-level session on session.start by itself. This
 * (re)starts the bus's tracker for sessionId; it emits nothing until a workspace provider is
 * registered on that bus.
 */
export function trackWorkspace(
  bus: EventBus,
  sessionId: string,
  cwd: string,
  opts: WorkspaceOptions = {},
): () => void {
  return workspaceFor(bus).start(sessionId, cwd, opts)
}
