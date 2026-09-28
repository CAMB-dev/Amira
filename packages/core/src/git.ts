export interface GitInfo {
  repoRoot?: string
  branch?: string
  isWorktree?: boolean
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" })
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
    return code === 0 ? out.trim() : undefined
  } catch {
    return undefined
  }
}

/** Best-effort git facts about cwd; every field is omitted when unknown. */
export async function gitInfo(cwd: string): Promise<GitInfo> {
  const top = await git(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--abbrev-ref",
    "HEAD",
    "--git-dir",
    "--git-common-dir",
  ])
  if (!top) return {}
  const [repoRoot, branch, gitDir, commonDir] = top.split(/\r?\n/)
  const info: GitInfo = {}
  if (repoRoot) info.repoRoot = repoRoot
  if (branch && branch !== "HEAD") info.branch = branch
  if (gitDir && commonDir) info.isWorktree = gitDir !== commonDir
  return info
}
