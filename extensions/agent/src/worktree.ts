import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"

/** Runs git in `cwd`. `stdoutOnly` keeps stderr out of the output, for commands whose output is parsed. */
export type RunGit = (
  args: string[],
  cwd: string,
  stdoutOnly?: boolean,
) => Promise<{ output: string; ok: boolean }>

/** A sub-agent's private checkout (D62), made from the parent's working tree. */
export interface Worktree {
  /** The repository the changes merge back into. */
  root: string
  /** The worktree itself: `~/.amira/worktrees/<project>/<name>`. */
  dir: string
  /** Where the child works: the worktree's counterpart of the parent's directory. */
  cwd: string
  /** The commit the worktree started from; its changes are diffed against it. */
  base: string
  /** The child's changes as a binary patch, once collected. */
  patch: string
}

export interface ChangeStat {
  files: string[]
  insertions: number
  deletions: number
}

export type MergeOutcome = "merged" | "empty" | "partial" | "kept" | "discarded"

export interface MergeResult {
  outcome: MergeOutcome
  stat: ChangeStat
  /** Why the changes did not merge cleanly, if they did not. */
  conflict?: string
  /** Files git could not patch; their hunks are in `<file>.rej` (outcome "partial"). */
  rejected?: string[]
}

/** Clean merges past either size are reviewed too (D38). */
export interface ReviewThreshold {
  lines?: number
  files?: number
}

export type Review = (title: string, diff: string, options: string[]) => Promise<string | undefined>

/** git needs an identity to write the snapshot commit even where the user has none configured. */
const SNAPSHOT_IDENTITY = ["-c", "user.name=Amira", "-c", "user.email=amira@localhost"]

/** `<repo folder>-<hash of its path>`, so two projects with the same folder name never share a directory. */
export function projectKey(root: string): string {
  const key = process.platform === "win32" ? root.toLowerCase() : root
  return `${path.basename(root)}-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`
}

/**
 * Creates a worktree for a sub-agent. It starts from the parent's working tree as it is now,
 * uncommitted changes to tracked files included (untracked files are not copied), without
 * touching the parent's checkout. Returns a reason instead when `cwd` cannot have one (D16).
 */
export async function createWorktree(
  git: RunGit,
  opts: { cwd: string; home: string; name: string },
): Promise<Worktree | { error: string }> {
  const top = await git(["rev-parse", "--show-toplevel"], opts.cwd, true)
  if (!top.ok || !top.output.trim()) return { error: "not a git repository" }
  const root = path.normalize(top.output.trim())
  const head = await git(["rev-parse", "--verify", "-q", "HEAD"], root, true)
  if (!head.ok) return { error: "the repository has no commits yet" }
  const snapshot = await git([...SNAPSHOT_IDENTITY, "stash", "create"], root, true)
  const base = (snapshot.ok && snapshot.output.trim()) || head.output.trim()
  const dir = path.join(opts.home, "worktrees", projectKey(root), opts.name)
  mkdirSync(path.dirname(dir), { recursive: true })
  const add = await git(["worktree", "add", "--detach", dir, base], root)
  if (!add.ok) return { error: `git worktree add failed: ${add.output.trim()}` }
  const rel = path.relative(root, path.resolve(opts.cwd))
  const cwd = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? path.join(dir, rel) : dir
  return { root, dir, cwd, base, patch: `${dir}.diff` }
}

/** Records everything the child changed in its worktree (commits included) as a patch against the base. */
export async function collectChanges(git: RunGit, wt: Worktree): Promise<ChangeStat> {
  const add = await git(["add", "-A"], wt.dir)
  if (!add.ok) throw new Error(`git add failed in ${wt.dir}: ${add.output.trim()}`)
  const diff = await git(["diff", "--cached", "--binary", `--output=${wt.patch}`, wt.base], wt.dir)
  if (!diff.ok) throw new Error(`git diff failed in ${wt.dir}: ${diff.output.trim()}`)
  const num = await git(["diff", "--cached", "--numstat", wt.base], wt.dir, true)
  return parseNumstat(num.output)
}

export function parseNumstat(output: string): ChangeStat {
  const stat: ChangeStat = { files: [], insertions: 0, deletions: 0 }
  for (const line of output.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (!m) continue
    stat.files.push(m[3]!)
    if (m[1] !== "-") stat.insertions += Number(m[1])
    if (m[2] !== "-") stat.deletions += Number(m[2])
  }
  return stat
}

export function formatStat(stat: ChangeStat): string {
  const n = stat.files.length
  return `${n} file${n === 1 ? "" : "s"}, +${stat.insertions} -${stat.deletions}`
}

function overThreshold(stat: ChangeStat, t: ReviewThreshold | undefined): boolean {
  if (!t) return false
  if (t.files !== undefined && stat.files.length > t.files) return true
  return t.lines !== undefined && stat.insertions + stat.deletions > t.lines
}

export const MERGE = "merge"
export const APPLY_PARTIAL = "apply what fits (.rej files for the rest)"
export const KEEP = "keep in worktree"
export const DISCARD = "discard"

/**
 * Merges a finished child's worktree into the parent's working tree (D16, D38). A patch that
 * applies cleanly and stays under the threshold is applied at once; otherwise the diff goes to
 * `review`. Nobody answering keeps the worktree, so nothing is lost. The worktree is removed
 * once its changes are merged or discarded.
 */
export async function mergeWorktree(
  git: RunGit,
  wt: Worktree,
  opts: { threshold?: ReviewThreshold; review?: Review } = {},
): Promise<MergeResult> {
  const stat = await collectChanges(git, wt)
  if (!stat.files.length) {
    await removeWorktree(git, wt)
    return { outcome: "empty", stat }
  }
  const apply = (extra: string[] = []) =>
    git(["apply", "--binary", "--whitespace=nowarn", ...extra, wt.patch], wt.root)
  const check = await apply(["--check"])
  const conflict = check.ok ? undefined : check.output.trim() || "the patch does not apply"
  if (!conflict && !overThreshold(stat, opts.threshold)) {
    const done = await apply()
    if (done.ok) {
      await removeWorktree(git, wt)
      return { outcome: "merged", stat }
    }
  }
  const title = conflict
    ? `Sub-agent changes conflict with the working tree (${formatStat(stat)})`
    : `Merge sub-agent changes (${formatStat(stat)})?`
  const options = conflict ? [APPLY_PARTIAL, KEEP, DISCARD] : [MERGE, KEEP, DISCARD]
  const choice = opts.review ? await opts.review(title, readPatch(wt.patch), options) : undefined
  const result = (outcome: MergeOutcome, extra: Partial<MergeResult> = {}): MergeResult => ({
    outcome,
    stat,
    ...(conflict ? { conflict } : {}),
    ...extra,
  })
  if (choice === DISCARD) {
    await removeWorktree(git, wt)
    return result("discarded")
  }
  if (choice === MERGE) {
    const done = await apply()
    if (done.ok) {
      await removeWorktree(git, wt)
      return result("merged")
    }
    return result("kept", { conflict: done.output.trim() })
  }
  if (choice === APPLY_PARTIAL) {
    // The worktree stays, so the rejected hunks can still be looked up in context.
    const done = await apply(["--reject"])
    return result("partial", { rejected: rejectedFiles(done.output) })
  }
  return result("kept")
}

/** Files named in `git apply --reject` output as having rejected hunks. */
function rejectedFiles(output: string): string[] {
  const files = new Set<string>()
  for (const m of output.matchAll(/^Applying patch (.+?) with \d+ reject/gm)) files.add(m[1]!)
  return [...files]
}

function readPatch(file: string): string {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

/** Removes the worktree and its patch; a stubborn directory is deleted and pruned instead. */
export async function removeWorktree(git: RunGit, wt: Worktree): Promise<void> {
  const removed = await git(["worktree", "remove", "--force", wt.dir], wt.root)
  if (!removed.ok) {
    rmSync(wt.dir, { recursive: true, force: true })
    await git(["worktree", "prune"], wt.root)
  }
  rmSync(wt.patch, { force: true })
}
