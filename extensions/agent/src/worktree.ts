import { createHash } from "node:crypto"
import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
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
  /** Why the worktree could not be removed after its changes were merged or discarded. */
  cleanup?: string
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

export const MERGE = "Merge"
export const APPLY_PARTIAL = "Apply what fits (.rej files for the rest)"
export const KEEP = "Keep in the worktree"
export const DISCARD = "Discard"

/**
 * Merges a finished child's worktree into the parent's working tree (D16, D38). A patch that
 * applies cleanly and stays under the threshold is applied at once; otherwise the diff goes to
 * `review`. Nobody answering keeps the worktree, so nothing is lost. The worktree is removed
 * once its changes are merged or discarded.
 */
export async function mergeWorktree(
  git: RunGit,
  wt: Worktree,
  opts: {
    threshold?: ReviewThreshold
    review?: Review
    rm?: Remove
    /** Whose changes they are, for the review's title: the sub-agent's title and role. */
    by?: string
  } = {},
): Promise<MergeResult> {
  const stat = await collectChanges(git, wt)
  // The merge alone decides the outcome; a worktree that cannot be removed is only noted.
  const cleanup = async (): Promise<Partial<MergeResult>> => {
    const problem = await removeWorktree(git, wt, opts.rm)
    return problem ? { cleanup: problem } : {}
  }
  if (!stat.files.length) return { outcome: "empty", stat, ...(await cleanup()) }
  const apply = (extra: string[] = []) =>
    git(["apply", "--binary", "--whitespace=nowarn", ...extra, wt.patch], wt.root)
  const check = await apply(["--check"])
  const conflict = check.ok ? undefined : check.output.trim() || "the patch does not apply"
  if (!conflict && !overThreshold(stat, opts.threshold)) {
    const done = await apply()
    if (done.ok) return { outcome: "merged", stat, ...(await cleanup()) }
  }
  const whose = opts.by ? `Changes of ${opts.by}` : "Sub-agent changes"
  const title = conflict
    ? `${whose} conflict with the working tree (${formatStat(stat)})`
    : `Merge ${opts.by ? `the changes of ${opts.by}` : "sub-agent changes"} (${formatStat(stat)})?`
  const options = conflict ? [APPLY_PARTIAL, KEEP, DISCARD] : [MERGE, KEEP, DISCARD]
  const choice = opts.review ? await opts.review(title, readPatch(wt.patch), options) : undefined
  const result = (outcome: MergeOutcome, extra: Partial<MergeResult> = {}): MergeResult => ({
    outcome,
    stat,
    ...(conflict ? { conflict } : {}),
    ...extra,
  })
  if (choice === DISCARD) return result("discarded", await cleanup())
  if (choice === MERGE) {
    const done = await apply()
    if (done.ok) return result("merged", await cleanup())
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

/**
 * Collects the changes of a child that did not finish (aborted, failed, or its commander was
 * interrupted) without merging them: half-done work stays in the worktree to be looked at.
 */
export async function keepChanges(git: RunGit, wt: Worktree, rm?: Remove): Promise<MergeResult> {
  const stat = await collectChanges(git, wt)
  if (stat.files.length) return { outcome: "kept", stat }
  const problem = await removeWorktree(git, wt, rm)
  return { outcome: "empty", stat, ...(problem ? { cleanup: problem } : {}) }
}

/** Deletes a file or directory tree; replaceable in tests. */
export type Remove = (target: string, opts: { recursive?: boolean; force?: boolean }) => void

/**
 * Removes the worktree and its patch as far as it can: on Windows a directory that is some
 * process's working directory cannot be deleted. Returns why the worktree stayed, if it did.
 */
export async function removeWorktree(
  git: RunGit,
  wt: Worktree,
  rm: Remove = rmSync,
): Promise<string | undefined> {
  const removed = await git(["worktree", "remove", "--force", wt.dir], wt.root)
  let problem: string | undefined
  if (!removed.ok) {
    try {
      rm(wt.dir, { recursive: true, force: true })
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err)
    }
    // Forgets the worktree once its directory, or at least the .git file in it, is gone.
    await git(["worktree", "prune"], wt.root)
  }
  try {
    rm(wt.patch, { force: true })
  } catch {}
  return problem
}

/** How old a worktree left behind must be before the sweep deletes it. */
export const STALE_WORKTREE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Deletes the worktrees of `root` that earlier sessions left behind (killed mid-run, unable to
 * delete them, or kept for review and never cleaned up) once they are older than `maxAgeMs`,
 * with their patches, and prunes git's records of worktrees whose directory is gone.
 * Returns the names it deleted.
 */
export async function sweepWorktrees(
  git: RunGit,
  opts: { root: string; home: string; maxAgeMs?: number; now?: number; rm?: Remove },
): Promise<string[]> {
  const dir = path.join(opts.home, "worktrees", projectKey(opts.root))
  const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeMs ?? STALE_WORKTREE_MS)
  const rm = opts.rm ?? rmSync
  const removed: string[] = []
  let entries: Dirent[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {}
  for (const e of entries) {
    const full = path.join(dir, e.name)
    try {
      if (statSync(full).mtimeMs >= cutoff) continue
      if (e.isDirectory()) {
        await git(["worktree", "remove", "--force", full], opts.root)
        rm(full, { recursive: true, force: true })
        rm(`${full}.diff`, { force: true })
        removed.push(e.name)
      } else if (e.name.endsWith(".diff") && !existsSync(full.slice(0, -".diff".length))) {
        rm(full, { force: true })
      }
    } catch {}
  }
  await git(["worktree", "prune"], opts.root)
  return removed
}
