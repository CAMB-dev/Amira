import { createHash } from "node:crypto"
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
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
  opts: {
    cwd: string
    home: string
    name: string
    /** Whose worktree it is, kept next to it for /agents should it be left behind. */
    about?: { title: string; role: string }
  },
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
  const meta: WorktreeMeta = { ...opts.about, base }
  try {
    writeFileSync(metaFile(dir), JSON.stringify(meta))
  } catch {}
  return { root, dir, cwd, base, patch: `${dir}.diff` }
}

/** What is known of a worktree besides its files, kept next to it as `<dir>.json`. */
export interface WorktreeMeta {
  /** The task's title and the role of the sub-agent that worked in it. */
  title?: string
  role?: string
  /** The commit it started from. */
  base?: string
}

const metaFile = (dir: string) => `${dir}.json`

function readMeta(dir: string): WorktreeMeta {
  try {
    const m = JSON.parse(readFileSync(metaFile(dir), "utf8")) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)
    const title = str(m.title)
    const role = str(m.role)
    const base = str(m.base)
    return { ...(title ? { title } : {}), ...(role ? { role } : {}), ...(base ? { base } : {}) }
  } catch {
    return {}
  }
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
    /** Whose changes they are, for the review's title: e.g. `"Fix the parser" (coder)`. */
    who?: string
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
  const whose = opts.who ? `The changes of ${opts.who}` : "Sub-agent changes"
  const title = conflict
    ? `${whose} conflict with the working tree (${formatStat(stat)})`
    : `Merge ${opts.who ? `the changes of ${opts.who}` : "sub-agent changes"} (${formatStat(stat)})?`
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
  for (const file of [wt.patch, metaFile(wt.dir), expiringMark(wt.dir)]) {
    try {
      rm(file, { force: true })
    } catch {}
  }
  return problem
}

/** How old a worktree left behind must be before the sweep deletes it. */
export const STALE_WORKTREE_MS = 7 * 24 * 60 * 60 * 1000
/** How long after the user was told a stale worktree goes that the sweep deletes it. */
export const STALE_NOTICE_MS = 24 * 60 * 60 * 1000

/** A sub-agent's worktree left behind with its changes (kept for review, or not removable). */
export interface KeptWorktree extends WorktreeMeta {
  name: string
  dir: string
  /** Its changes as a patch, when they were collected. */
  patch?: string
  /** When it last changed. */
  modifiedAt: number
  /** The user was told it is about to be deleted (the sweep deletes it after STALE_NOTICE_MS). */
  expiring: boolean
  /**
   * The earliest the sweep deletes it: a day after the user was told, or, not told yet, a day
   * after it is old enough to be announced.
   */
  deleteAfter: number
}

/** Marks a worktree whose deletion the user was told about; it holds when that was. */
const expiringMark = (dir: string) => `${dir}.expiring`

/** A worktree of the sweep's directory as KeptWorktree describes it. */
function keptWorktree(full: string, limits: { maxAgeMs?: number; noticeMs?: number } = {}): KeptWorktree {
  const modifiedAt = statSync(full).mtimeMs
  const mark = expiringMark(full)
  const expiring = existsSync(mark)
  const notice = limits.noticeMs ?? STALE_NOTICE_MS
  return {
    name: path.basename(full),
    dir: full,
    ...readMeta(full),
    ...(existsSync(`${full}.diff`) ? { patch: `${full}.diff` } : {}),
    modifiedAt,
    expiring,
    deleteAfter: expiring
      ? statSync(mark).mtimeMs + notice
      : modifiedAt + (limits.maxAgeMs ?? STALE_WORKTREE_MS) + notice,
  }
}

/** The worktrees of `root` left behind under `home`, newest first. */
export function listKeptWorktrees(home: string, root: string): KeptWorktree[] {
  const dir = path.join(home, "worktrees", projectKey(root))
  let entries: Dirent[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {}
  const out: KeptWorktree[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const full = path.join(dir, e.name)
    try {
      out.push(keptWorktree(full))
    } catch {}
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export interface SweepResult {
  /** Worktrees deleted now: the user was told at least STALE_NOTICE_MS before. */
  removed: string[]
  /** Stale worktrees the user is told about now; the next sweep a day or more later deletes them. */
  expiring: KeptWorktree[]
}

/**
 * Cleans up the worktrees of `root` that earlier sessions left behind (killed mid-run, unable
 * to delete them, or kept for review and never cleaned up), never without warning: one older
 * than `maxAgeMs` is marked and reported as `expiring` first, and deleted (with its patch) by a
 * sweep at least `noticeMs` later. git's records of worktrees whose directory is gone are pruned.
 * `keep` names directories not to touch (worktrees in use now).
 */
export async function sweepWorktrees(
  git: RunGit,
  opts: {
    root: string
    home: string
    maxAgeMs?: number
    noticeMs?: number
    now?: number
    rm?: Remove
    keep?: ReadonlySet<string>
  },
): Promise<SweepResult> {
  const dir = path.join(opts.home, "worktrees", projectKey(opts.root))
  const now = opts.now ?? Date.now()
  const cutoff = now - (opts.maxAgeMs ?? STALE_WORKTREE_MS)
  const told = now - (opts.noticeMs ?? STALE_NOTICE_MS)
  const rm = opts.rm ?? rmSync
  const out: SweepResult = { removed: [], expiring: [] }
  let entries: Dirent[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {}
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (opts.keep?.has(full)) continue
    try {
      if (e.isDirectory()) {
        const mark = expiringMark(full)
        if (statSync(full).mtimeMs >= cutoff) {
          // Changed since it was marked: it is no longer about to go.
          if (existsSync(mark)) rm(mark, { force: true })
          continue
        }
        if (!existsSync(mark)) {
          writeFileSync(mark, new Date(now).toISOString())
          out.expiring.push(keptWorktree(full, opts))
          continue
        }
        if (statSync(mark).mtimeMs > told) continue
        await git(["worktree", "remove", "--force", full], opts.root)
        rm(full, { recursive: true, force: true })
        rm(`${full}.diff`, { force: true })
        rm(metaFile(full), { force: true })
        rm(mark, { force: true })
        out.removed.push(e.name)
      } else if (statSync(full).mtimeMs < cutoff) {
        const base = full.replace(/\.(diff|expiring|json)$/, "")
        if (base !== full && !existsSync(base)) rm(full, { force: true })
      }
    } catch {}
  }
  await git(["worktree", "prune"], opts.root)
  return out
}

/** A kept worktree as the functions that take a Worktree want it. */
function asWorktree(root: string, w: KeptWorktree): Worktree {
  return { root, dir: w.dir, cwd: w.dir, base: w.base ?? "HEAD", patch: `${w.dir}.diff` }
}

/**
 * The changes of a kept worktree as a patch, with their size. They are collected again when it
 * is known what the worktree started from (someone may have changed it since); otherwise its
 * patch is taken as it is, or, without one, the changes since its current commit.
 */
export async function keptChanges(
  git: RunGit,
  root: string,
  w: KeptWorktree,
): Promise<{ patch: string; stat: ChangeStat }> {
  const wt = asWorktree(root, w)
  if (w.base || !w.patch) return { stat: await collectChanges(git, wt), patch: readPatch(wt.patch) }
  const num = await git(["apply", "--numstat", wt.patch], root, true)
  return { patch: readPatch(wt.patch), stat: parseNumstat(num.output) }
}

export type KeptMerge =
  | { outcome: "merged" | "empty"; stat: ChangeStat; cleanup?: string }
  | { outcome: "conflict"; stat: ChangeStat; conflict: string }

/**
 * Applies a kept worktree's changes to the working tree of `root` and removes the worktree.
 * Changes that do not apply cleanly are not applied at all: the worktree stays as it is.
 */
export async function mergeKept(git: RunGit, root: string, w: KeptWorktree, rm?: Remove): Promise<KeptMerge> {
  const { stat } = await keptChanges(git, root, w)
  const wt = asWorktree(root, w)
  const cleanup = async () => {
    const problem = await removeWorktree(git, wt, rm)
    return problem ? { cleanup: problem } : {}
  }
  if (!stat.files.length) return { outcome: "empty", stat, ...(await cleanup()) }
  const apply = (extra: string[] = []) =>
    git(["apply", "--binary", "--whitespace=nowarn", ...extra, wt.patch], root)
  const check = await apply(["--check"])
  const done = check.ok ? await apply() : check
  if (!done.ok)
    return { outcome: "conflict", stat, conflict: done.output.trim() || "the patch does not apply" }
  return { outcome: "merged", stat, ...(await cleanup()) }
}

/** Deletes a kept worktree with its patch; says why it stayed, if it did. */
export function discardKept(
  git: RunGit,
  root: string,
  w: KeptWorktree,
  rm?: Remove,
): Promise<string | undefined> {
  return removeWorktree(git, asWorktree(root, w), rm)
}

/**
 * Keeps a worktree as if it had just changed: it is no longer about to be deleted, and the
 * sweep announces it again only once it is STALE_WORKTREE_MS old from now.
 */
export function extendKept(w: KeptWorktree, now = Date.now()): KeptWorktree {
  const at = new Date(now)
  utimesSync(w.dir, at, at)
  rmSync(expiringMark(w.dir), { force: true })
  return keptWorktree(w.dir)
}
