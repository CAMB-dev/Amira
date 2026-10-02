import { statSync } from "node:fs"
import path from "node:path"
import type { ExtensionAPI, WorkspaceProvider } from "@amira/api"

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
  runCommand: ExtensionAPI["runCommand"],
  signal: AbortSignal,
  cwd: string,
  args: string[],
  timeoutMs: number,
  env?: Record<string, string | undefined>,
): Promise<string | undefined> {
  try {
    const run = await runCommand(["git", ...args], {
      cwd,
      timeoutMs,
      signal,
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
  api: Pick<ExtensionAPI, "runCommand">,
  cwd: string,
  timeoutMs = 15_000,
  opts: { dirty?: boolean } = {},
): Promise<GitInfo> {
  return (await probe(api.runCommand, new AbortController().signal, cwd, timeoutMs, opts.dirty ?? false)).info
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
async function dirtyOf(
  runCommand: ExtensionAPI["runCommand"],
  signal: AbortSignal,
  cwd: string,
  timeoutMs: number,
): Promise<boolean | undefined> {
  const out = await git(
    runCommand,
    signal,
    cwd,
    ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=dirty"],
    timeoutMs,
    { GIT_OPTIONAL_LOCKS: "0" },
  )
  return out === undefined ? undefined : out !== ""
}

async function probe(
  runCommand: ExtensionAPI["runCommand"],
  signal: AbortSignal,
  cwd: string,
  timeoutMs: number,
  withDirty: boolean,
): Promise<Probe> {
  const [dirs, branch, head, dirty] = await Promise.all([
    git(
      runCommand,
      signal,
      cwd,
      ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"],
      timeoutMs,
    ),
    git(runCommand, signal, cwd, ["symbolic-ref", "--short", "-q", "HEAD"], timeoutMs),
    git(runCommand, signal, cwd, ["rev-parse", "--short", "HEAD"], timeoutMs),
    withDirty ? dirtyOf(runCommand, signal, cwd, timeoutMs) : undefined,
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

/** Git owns metadata caching; the host decides when and what to probe. */
export function gitWorkspaceProvider(api: Pick<ExtensionAPI, "runCommand">): WorkspaceProvider {
  let cached: { cwd: string; probe: Probe } | undefined
  return {
    async probe(cwd, signal, kind = "full") {
      const previous = cached?.cwd === cwd ? cached.probe : undefined
      if (kind === "dirty" && previous && !previous.gitDir) return { cwd, ...previous.info }
      let result: Probe
      if (kind === "dirty" && previous?.gitDir) {
        const dirty = await dirtyOf(api.runCommand, signal, cwd, 15_000)
        const { dirty: _, ...rest } = previous.info
        result = { ...previous, info: dirty === undefined ? rest : { ...rest, dirty } }
      } else result = await probe(api.runCommand, signal, cwd, 15_000, true)
      if (signal.aborted) return undefined
      cached = { cwd, probe: result }
      return { cwd, ...result.info }
    },
    stamp(cwd) {
      if (!insideRepo(cwd)) return ""
      const previous = cached?.cwd === cwd ? cached.probe : undefined
      return previous?.gitDir ? headStamp(previous) : undefined
    },
  }
}
