import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import {
  amiraHome,
  type FileLock,
  isProcessAlive,
  LockBusyError,
  tryFileLock,
  waitFileLock,
} from "@amira/core"
import { readLock } from "./lock.ts"
import { PackageError } from "./manifest.ts"
import { knownProjectLocks } from "./project-locks.ts"
import { COMMAND_TIMEOUT_MS, lastLines, runTool, ToolError } from "./run.ts"

/**
 * Git repositories that packages come from are kept once per repository, as blobless bare
 * clones under `~/.amira/cache/git/<key>.git`: updates fetch only what changed, and a package
 * in a subdirectory downloads only that subdirectory's files.
 */
export function defaultGitCacheDir(home = amiraHome()): string {
  return path.join(home, "cache", "git")
}

/** Caches no package uses are deleted once they were not used for this long. */
export const GIT_CACHE_UNUSED_DAYS = 30

/** A lock is held for a fetch and a checkout, each of which may take up to COMMAND_TIMEOUT_MS. */
const LOCK_STALE_MS = 4 * COMMAND_TIMEOUT_MS
const LOCK_WAIT_MS = 2 * COMMAND_TIMEOUT_MS
/** A holder touches its lock this often, so a long hold never looks stale. */
const LOCK_HEARTBEAT_MS = 30_000
const META = "amira-cache.json"

export type GitPhase = "resolving" | "waiting" | "fetching" | "extracting"

export interface GitContext {
  signal?: AbortSignal
  progress?: (phase: GitPhase, detail?: string, percent?: number) => void
  log?: (line: string) => void
}

/**
 * The same repository under the URLs people write for it: no trailing slash or `.git`, and the
 * scheme and host in lower case.
 */
export function normalizeGitUrl(url: string): string {
  let u = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(.*)$/i.exec(u)
  if (m) u = `${m[1]!.toLowerCase()}://${m[2]!.toLowerCase()}${m[3]}`
  else {
    const scp = /^([^@/:]+@)?([^/:]+):(.*)$/.exec(u)
    if (scp && !/^[A-Za-z]$/.test(scp[2]!)) u = `${scp[1] ?? ""}${scp[2]!.toLowerCase()}:${scp[3]}`
  }
  return u
}

export function gitCacheKey(url: string): string {
  return createHash("sha256").update(normalizeGitUrl(url)).digest("hex").slice(0, 24)
}

/** A short name for progress lines: `owner/repo` of a URL. */
export function repoLabel(url: string): string {
  const parts = normalizeGitUrl(url).split(/[/:]/).filter(Boolean)
  return parts.slice(-2).join("/") || url
}

const FULL_ID = /^([0-9a-f]{40}|[0-9a-f]{64})$/i

export function isFullCommitId(s: string): boolean {
  return FULL_ID.test(s)
}

/** What the remote says: the commit `ref` (or HEAD) names, if any, and HEAD's branch. */
type RemoteLookup = { commit?: string; headRef?: string } | { unreachable: string }

export interface ResolveRequest {
  url: string
  /** A full commit id that must be used, e.g. the lock's pin. */
  commit?: string
  /** A branch, tag or (abbreviated) commit; default the remote's HEAD. */
  ref?: string
  /**
   * Updating: the network must answer; without it the commit is unknown and nothing is guessed
   * from the cache.
   */
  requireRemote?: boolean
}

/** A repository in the cache, locked while the callback runs. */
export interface CachedRepo {
  readonly dir: string
  readonly commit: string
  /** The object ids of `<commit>:<path>` specs, undefined for those the cache lacks. */
  treesOf(specs: string[]): Promise<(string | undefined)[]>
  /** Checks out `sub` of the commit (the whole tree when empty) into the empty directory `dest`. */
  materialize(sub: string, dest: string, indexFile: string): Promise<void>
}

/**
 * The cache of one command: each repository is asked and fetched at most once, however many
 * packages come from it.
 */
export class GitCache {
  private readonly fetched = new Set<string>()
  private readonly remotes = new Map<string, Promise<RemoteLookup>>()
  /** Repositories found valid, commits found present, HEADs set: this command need not ask again. */
  private readonly ready = new Set<string>()
  private readonly present = new Set<string>()
  private readonly headSet = new Set<string>()
  /** How many network round trips of each kind were made; for tests and measurements. */
  readonly stats = { lsRemote: 0, clone: 0, fetch: 0 }

  constructor(readonly dir: string = defaultGitCacheDir()) {}

  repoDir(url: string): string {
    return path.join(this.dir, `${gitCacheKey(url)}.git`)
  }

  /** The commit `ref` (or HEAD) has on the remote, without downloading anything. */
  remoteCommit(url: string, ref: string | undefined, ctx: GitContext): Promise<RemoteLookup> {
    const key = `${gitCacheKey(url)} ${ref ?? ""}`
    let p = this.remotes.get(key)
    if (!p) {
      p = this.lsRemote(url, ref, ctx)
      this.remotes.set(key, p)
      // A cancelled lookup is not an answer for the next package.
      p.catch(() => this.remotes.delete(key))
    }
    return p
  }

  private async lsRemote(url: string, ref: string | undefined, ctx: GitContext): Promise<RemoteLookup> {
    ctx.progress?.("resolving", repoLabel(url))
    this.stats.lsRemote++
    mkdirSync(this.dir, { recursive: true })
    const patterns = ref ? [ref, `${ref}^{}`] : ["HEAD"]
    let out: string
    try {
      out = await runTool(
        ["git", "ls-remote", "--symref", "--", url, ...patterns],
        this.dir,
        "git ls-remote",
        {
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          timeoutMs: 60_000,
          env: outsideRepos(this.dir),
        },
      )
    } catch (err) {
      if (err instanceof ToolError && err.aborted) throw err
      ctx.signal?.throwIfAborted()
      return { unreachable: err instanceof ToolError ? err.output || err.message : String(err) }
    }
    const refs = new Map<string, string>()
    let headRef: string | undefined
    for (const line of out.split(/\r?\n/)) {
      const sym = /^ref: (\S+)\tHEAD$/.exec(line)
      if (sym) headRef = sym[1]
      const m = /^([0-9a-f]{40,64})\t(.+)$/.exec(line)
      if (m) refs.set(m[2]!, m[1]!)
    }
    const candidates = ref
      ? [`refs/tags/${ref}^{}`, `refs/tags/${ref}`, `refs/heads/${ref}`, `${ref}^{}`, ref]
      : ["HEAD"]
    const commit = candidates.map((c) => refs.get(c)).find(Boolean)
    return { ...(commit ? { commit } : {}), ...(headRef ? { headRef } : {}) }
  }

  /**
   * Finds the commit a request names, fetching into the cache only when it lacks it, and runs
   * `fn` with the repository locked against other amira processes.
   */
  async withCommit<T>(
    req: ResolveRequest,
    ctx: GitContext,
    fn: (repo: CachedRepo) => Promise<T>,
  ): Promise<T> {
    const { url } = req
    if (req.ref?.startsWith("-")) throw new PackageError(`not a git ref: ${req.ref}`)
    let target = req.commit && isFullCommitId(req.commit) ? req.commit.toLowerCase() : undefined
    const want = req.commit && !target ? req.commit : req.ref
    if (want?.startsWith("-")) throw new PackageError(`not a git ref or commit: ${want}`)
    let remote: RemoteLookup | undefined
    if (!target) {
      if (want && isFullCommitId(want)) target = want.toLowerCase()
      else {
        remote = await this.remoteCommit(url, want, ctx)
        if ("unreachable" in remote) {
          if (req.requireRemote)
            throw new PackageError(`cannot reach ${url}: ${firstLine(remote.unreachable)}`)
        } else target = remote.commit
      }
    }
    const offline = remote && "unreachable" in remote ? remote.unreachable : undefined
    mkdirSync(this.dir, { recursive: true })
    const lock = await this.lock(url, ctx)
    try {
      const dir = this.repoDir(url)
      const key = gitCacheKey(url)
      let fresh = false
      // Checked once per command (git is slow to start on Windows); after that, that it is there.
      const known = this.ready.has(key) && existsSync(path.join(dir, "HEAD"))
      if (!known && !(await isRepo(dir, ctx))) {
        if (offline !== undefined)
          throw new PackageError(`cannot reach ${url} and it is not in the cache: ${firstLine(offline)}`)
        await this.clone(url, dir, ctx)
        fresh = true
      }
      this.ready.add(key)
      const has = async (c: string) => {
        if (this.present.has(`${key} ${c}`)) return true
        const yes = await hasCommit(dir, c, ctx)
        if (yes) this.present.add(`${key} ${c}`)
        return yes
      }
      // Fetch when the cache lacks the commit (or, for a name the remote did not know, once
      // per command so that abbreviated ids and new refs are found).
      if (!fresh && offline === undefined && !this.fetched.has(key) && !(target && (await has(target)))) {
        await this.fetch(url, dir, ctx)
      }
      if (remote && !("unreachable" in remote) && remote.headRef && !this.headSet.has(key)) {
        await setHead(dir, remote.headRef, ctx)
        this.headSet.add(key)
      }
      let commit: string | undefined
      if (target) {
        if (!(await has(target)) && offline === undefined) {
          // Not on any branch or tag any more (a force-push), but the server may still have it.
          await this.fetchCommit(url, dir, target, ctx).catch(() => {})
        }
        if (!(await has(target))) {
          throw new PackageError(
            offline !== undefined
              ? `cannot reach ${url}, and its cached copy lacks commit ${target}: ${firstLine(offline)}`
              : `${url} has no commit ${target}`,
          )
        }
        commit = target
      } else {
        commit = await resolveInCache(dir, want, ctx)
        if (!commit) throw new PackageError(`${url} has no branch, tag or commit "${want}"`)
        if (offline !== undefined)
          ctx.log?.(`warning: cannot reach ${url}; using its cached copy (${firstLine(offline)})`)
      }
      writeMeta(dir, url)
      const found = commit
      return await fn({
        dir,
        commit: found,
        treesOf: (specs) => treesOf(dir, specs, ctx),
        materialize: (sub, dest, indexFile) => materialize(url, dir, found, sub, dest, indexFile, ctx),
      })
    } finally {
      lock.release()
    }
  }

  private async lock(url: string, ctx: GitContext): Promise<FileLock> {
    try {
      return await waitFileLock(path.join(this.dir, `${gitCacheKey(url)}.lock`), {
        staleMs: LOCK_STALE_MS,
        waitMs: LOCK_WAIT_MS,
        heartbeatMs: LOCK_HEARTBEAT_MS,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onWait: () => ctx.progress?.("waiting", `another amira is fetching ${repoLabel(url)}`),
      })
    } catch (err) {
      if (err instanceof LockBusyError) throw new PackageError(err.message)
      throw err
    }
  }

  private async clone(url: string, dir: string, ctx: GitContext) {
    // Cloned beside the cache's place and renamed in: a half-finished clone is never used.
    const tmp = `${dir}.tmp-${process.pid}`
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    const label = repoLabel(url)
    ctx.progress?.("fetching", label)
    this.stats.clone++
    try {
      await runTool(
        ["git", "clone", "--bare", "--filter=blob:none", "--progress", "--", url, tmp],
        this.dir,
        "git clone",
        {
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          onChunk: progressParser(ctx, "fetching", label),
          env: outsideRepos(this.dir),
        },
      )
      // A bare clone has no fetch refspec: keep branches as the remote has them.
      await git(tmp, ["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"], "git config", ctx)
      // Only now is the old (broken) copy replaced.
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      renameSync(tmp, dir)
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
      if (err instanceof ToolError && (err.aborted || ctx.signal?.aborted)) throw err
      ctx.signal?.throwIfAborted()
      if (err instanceof ToolError)
        throw new PackageError(`cannot download ${url}: ${firstLine(err.output || err.message)}`)
      if (err instanceof PackageError) throw err
      throw new PackageError(
        `cannot store ${url} in ${this.dir}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    this.fetched.add(gitCacheKey(url))
  }

  private async fetch(url: string, dir: string, ctx: GitContext) {
    const label = repoLabel(url)
    ctx.progress?.("fetching", label)
    this.stats.fetch++
    // From origin, not the URL: the partial clone filter is the remote's setting. Branches and
    // tags as the remote has them now: forced (a tag that moved), and pruned (deleted ones).
    const argv = [
      "fetch",
      "--prune",
      "--no-tags",
      "--progress",
      "--no-write-fetch-head",
      "origin",
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*",
    ]
    try {
      await git(dir, argv, "git fetch", ctx, progressParser(ctx, "fetching", label))
    } catch (err) {
      if (err instanceof ToolError && err.aborted) throw err
      ctx.signal?.throwIfAborted()
      // Only a broken cache is cloned again; a network failure keeps the cache as it is.
      if (await isRepo(dir, ctx)) {
        const why = err instanceof ToolError ? firstLine(err.output || err.message) : String(err)
        throw new PackageError(`cannot fetch ${url}: ${why}`)
      }
      ctx.log?.(`warning: the cache of ${url} is damaged; cloning it again`)
      await this.clone(url, dir, ctx)
    }
    this.fetched.add(gitCacheKey(url))
  }

  private async fetchCommit(url: string, dir: string, commit: string, ctx: GitContext) {
    this.stats.fetch++
    await git(
      dir,
      ["fetch", "--progress", "--no-write-fetch-head", "origin", commit],
      "git fetch",
      ctx,
      progressParser(ctx, "fetching", repoLabel(url)),
    )
  }
}

/**
 * For git run in the cache directory without a repository of its own (ls-remote, clone): a
 * repository around it (a home directory kept in git) must not lend its config.
 */
function outsideRepos(cacheDir: string): Record<string, string> {
  return { GIT_CEILING_DIRECTORIES: path.dirname(cacheDir) }
}

/** The line of git's output that says what went wrong: its first `fatal:` or `error:`. */
function firstLine(s: string): string {
  return (
    lastLines(s, 20)
      .split("\n")
      .find((l) => /^(fatal|error):/i.test(l)) ?? lastLines(s, 1)
  )
}

/**
 * For questions about what the cache holds: a partial clone would otherwise download a missing
 * object on the spot (git 2.45 and later honour this).
 */
const NO_LAZY = { GIT_NO_LAZY_FETCH: "1" }
const noLazySupport = new WeakMap<GitContext, Promise<boolean>>()

async function supportsNoLazyFetch(dir: string, ctx: GitContext): Promise<boolean> {
  try {
    const version = await runTool(["git", "--version"], path.dirname(dir), "git --version", {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      stdoutOnly: true,
    })
    const match = /git version (\d+)\.(\d+)/.exec(version)
    return !!match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 45))
  } catch (err) {
    if (err instanceof ToolError && err.aborted) throw err
    return false
  }
}

/** `git --git-dir=<dir> ...`: never searched for, so nothing around the cache is picked up. */
async function git(
  dir: string,
  args: string[],
  what: string,
  ctx: GitContext,
  onChunk?: (chunk: string) => void,
  env?: Record<string, string>,
  stdoutOnly = false,
): Promise<string> {
  let guard: string[] = []
  if (env === NO_LAZY) {
    let supported = noLazySupport.get(ctx)
    if (!supported) {
      supported = supportsNoLazyFetch(dir, ctx)
      noLazySupport.set(ctx, supported)
    }
    if (!(await supported)) {
      // Old git ignores GIT_NO_LAZY_FETCH. Disable the usual promisor and forbid transports
      // for legacy partialClone settings or other promisors. Supply the filter too: a legacy
      // lazy fetch otherwise writes it to the cache config before trying a transport.
      guard = [
        "-c",
        "remote.origin.partialclonefilter=blob:none",
        "-c",
        "remote.origin.promisor=false",
        "-c",
        "protocol.allow=never",
      ]
      // This whitelist overrides even protocol.<name>.allow=always in user or cache config.
      env = { GIT_ALLOW_PROTOCOL: "" }
    }
  }
  return runTool(["git", `--git-dir=${dir}`, ...guard, ...args], path.dirname(dir), what, {
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(onChunk ? { onChunk } : {}),
    ...(env ? { env } : {}),
    stdoutOnly,
  })
}

async function isRepo(dir: string, ctx: GitContext): Promise<boolean> {
  if (!existsSync(path.join(dir, "HEAD")) || !existsSync(path.join(dir, "objects"))) return false
  try {
    await git(dir, ["rev-parse", "--git-dir"], "git rev-parse", ctx, undefined, NO_LAZY, true)
    return true
  } catch (err) {
    if (err instanceof ToolError && err.aborted) throw err
    return false
  }
}

async function revParse(dir: string, spec: string, ctx: GitContext): Promise<string | undefined> {
  try {
    const out = await git(dir, ["rev-parse", "--verify", "--quiet", spec], "", ctx, undefined, NO_LAZY, true)
    return out.trim() || undefined
  } catch (err) {
    if (err instanceof ToolError && err.aborted) throw err
    return undefined
  }
}

/** Several object ids with one git; one by one when some are missing. */
async function treesOf(dir: string, specs: string[], ctx: GitContext): Promise<(string | undefined)[]> {
  try {
    const out = await git(dir, ["rev-parse", ...specs], "", ctx, undefined, NO_LAZY, true)
    const ids = out.split(/\r?\n/).filter(Boolean)
    if (ids.length === specs.length && ids.every(isFullCommitId)) return ids
  } catch (err) {
    if (err instanceof ToolError && err.aborted) throw err
  }
  return Promise.all(specs.map((s) => revParse(dir, s, ctx)))
}

async function hasCommit(dir: string, commit: string, ctx: GitContext): Promise<boolean> {
  return (await revParse(dir, `${commit}^{commit}`, ctx)) === commit.toLowerCase()
}

/** What a name means in the cache, the way a fresh clone would read it: tags, then branches. */
async function resolveInCache(
  dir: string,
  want: string | undefined,
  ctx: GitContext,
): Promise<string | undefined> {
  const candidates = want ? [`refs/tags/${want}`, `refs/heads/${want}`, want] : ["HEAD"]
  for (const c of candidates) {
    const id = await revParse(dir, `${c}^{commit}`, ctx)
    if (id) return id
  }
  return undefined
}

async function setHead(dir: string, headRef: string, ctx: GitContext) {
  if (!/^refs\/heads\/[^\s]+$/.test(headRef)) return
  try {
    const current = (
      await git(dir, ["symbolic-ref", "--quiet", "HEAD"], "", ctx, undefined, NO_LAZY, true)
    ).trim()
    if (current !== headRef) await git(dir, ["symbolic-ref", "HEAD", headRef], "git symbolic-ref", ctx)
  } catch (err) {
    if (err instanceof ToolError && err.aborted) throw err
  }
}

/**
 * Only `sub` of the commit, written as the repository has it: no autocrlf or platform line-end
 * conversion (the repository's own `eol` attributes still apply), symbolic links as plain files
 * holding their target (nothing can point outside the package), and long paths on Windows.
 * Git refuses paths such as `.git` or `..` itself. Missing file contents are downloaded in one
 * batch.
 */
async function materialize(
  url: string,
  dir: string,
  commit: string,
  sub: string,
  dest: string,
  indexFile: string,
  ctx: GitContext,
) {
  const spec = sub ? `${commit}:${sub}` : `${commit}^{tree}`
  let type = ""
  try {
    type = (await git(dir, ["cat-file", "-t", spec], "git cat-file", ctx, undefined, NO_LAZY, true)).trim()
  } catch (err) {
    if (err instanceof ToolError && err.aborted) throw err
  }
  if (type !== "tree") throw new PackageError(`${url} has no directory ${sub}`)
  mkdirSync(dest, { recursive: true })
  ctx.progress?.("extracting")
  await runTool(checkoutArgv(dir, dest, spec), dest, "git checkout", {
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    env: { GIT_INDEX_FILE: indexFile },
    onChunk: progressParser(ctx, "extracting", "downloading files"),
  }).catch((err: unknown) => {
    // The cache lacks some file contents and the remote cannot send them.
    if (err instanceof ToolError && !err.aborted && /promisor remote/i.test(err.output))
      throw new PackageError(
        `cannot download the files of ${url} at ${commit.slice(0, 12)}: ${firstLine(err.output)}`,
      )
    throw err
  })
}

function checkoutArgv(dir: string, dest: string, spec: string): string[] {
  return [
    "git",
    `--git-dir=${dir}`,
    `--work-tree=${dest}`,
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.eol=lf",
    "-c",
    "core.symlinks=false",
    "-c",
    "core.longpaths=true",
    "-c",
    "core.protectNTFS=true",
    "-c",
    "core.protectHFS=true",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.sparseCheckout=false",
    "read-tree",
    "--reset",
    "-u",
    spec,
  ]
}

/** Turns git's `--progress` lines into percentages. */
export function progressParser(ctx: GitContext, phase: GitPhase, detail: string): (chunk: string) => void {
  let last = -1
  let carry = ""
  return (chunk) => {
    const text = carry + chunk
    carry = text.slice(Math.max(text.lastIndexOf("\r"), text.lastIndexOf("\n")) + 1)
    let percent: number | undefined
    let what = ""
    for (const m of text.matchAll(/(Receiving objects|Resolving deltas):\s+(\d{1,3})%/g)) {
      what = m[1]!
      percent = Number(m[2])
    }
    if (percent === undefined) return
    // Resolving deltas is the tail of a download: count it as its last tenth.
    const overall = what === "Resolving deltas" ? 90 + Math.floor(percent / 10) : Math.floor(percent * 0.9)
    if (overall === last) return
    last = overall
    ctx.progress?.(phase, detail, Math.min(overall, 100))
  }
}

function writeMeta(dir: string, url: string) {
  try {
    writeFileSync(path.join(dir, META), `${JSON.stringify({ url, lastUsed: new Date().toISOString() })}\n`)
  } catch {}
}

export interface GitCacheEntry {
  key: string
  dir: string
  url?: string
  lastUsed?: Date
  bytes: number
}

/** The repositories in the cache, with the URL and time they were last used for. */
export function listGitCaches(cacheDir: string): GitCacheEntry[] {
  let names: string[]
  try {
    names = readdirSync(cacheDir)
  } catch {
    return []
  }
  const out: GitCacheEntry[] = []
  for (const n of names.sort()) {
    const m = /^([0-9a-f]{24})\.git$/.exec(n)
    if (!m) continue
    const dir = path.join(cacheDir, n)
    let url: string | undefined
    let lastUsed: Date | undefined
    try {
      const meta = JSON.parse(readFileSync(path.join(dir, META), "utf8"))
      if (typeof meta.url === "string") url = meta.url
      const t = Date.parse(meta.lastUsed)
      if (Number.isFinite(t)) lastUsed = new Date(t)
    } catch {}
    out.push({
      key: m[1]!,
      dir,
      ...(url ? { url } : {}),
      ...(lastUsed ? { lastUsed } : {}),
      bytes: sizeOf(dir),
    })
  }
  return out
}

function sizeOf(p: string): number {
  try {
    const st = lstatSync(p)
    if (!st.isDirectory()) return st.size
    let total = 0
    for (const n of readdirSync(p)) total += sizeOf(path.join(p, n))
    return total
  } catch {
    return 0
  }
}

/** Deletes one cached repository; false when another amira process is using it. */
export function removeGitCache(cacheDir: string, key: string): boolean {
  return removeCache(cacheDir, key, false)
}

function removeCache(cacheDir: string, key: string, dryRun: boolean): boolean {
  if (!/^[0-9a-f]{24}$/.test(key)) throw new PackageError(`not a git cache key: ${key}`)
  let lock: FileLock | undefined
  try {
    lock = tryFileLock(path.join(cacheDir, `${key}.lock`), LOCK_STALE_MS)
  } catch {
    return false
  }
  if (!lock) return false
  try {
    if (!dryRun) rmSync(path.join(cacheDir, `${key}.git`), { recursive: true, force: true, maxRetries: 3 })
    return true
  } finally {
    lock.release()
  }
}

export interface PruneOptions {
  /** URLs packages still come from; their caches are kept. */
  keepUrls?: Iterable<string>
  /** Only caches unused for longer than this; default all that are not kept. */
  unusedForMs?: number
  /** Lists removable repositories and interrupted clones without deleting them. */
  dryRun?: boolean
  now?: number
}

/**
 * Deletes the caches of repositories no package uses (that were not used for `unusedForMs`),
 * and clones left behind by interrupted commands. Caches in use by another process stay.
 */
export function pruneGitCaches(cacheDir: string, opts: PruneOptions = {}): GitCacheEntry[] {
  const keep = new Set([...(opts.keepUrls ?? [])].map(gitCacheKey))
  const now = opts.now ?? Date.now()
  const removed: GitCacheEntry[] = []
  for (const e of listGitCaches(cacheDir)) {
    if (keep.has(e.key)) continue
    // No record of use: judged by when the directory last changed.
    const used = e.lastUsed?.getTime() ?? mtimeOf(e.dir)
    if (opts.unusedForMs !== undefined && now - used < opts.unusedForMs) continue
    if (removeCache(cacheDir, e.key, !!opts.dryRun)) removed.push(e)
  }
  removed.push(...removeStaleClones(cacheDir, !!opts.dryRun))
  return removed
}

/** Git repositories pinned by the user lock and locks beneath every known project path. */
export function gitUrlsInUse(where: { home?: string; cwd: string }): string[] {
  return gitCachePins(where).urls
}

/**
 * The repositories known locks pin, and the lock files that could not be read: a lock that
 * can't be read may pin anything, so callers keep every cache while one is listed here.
 */
export function gitCachePins(where: { home?: string; cwd: string }): {
  urls: string[]
  unreadable: string[]
} {
  const urls = new Set<string>()
  const unreadable: string[] = []
  for (const file of knownProjectLocks(where)) {
    try {
      // readLock treats any read failure as an empty lock; only a missing file really is one.
      try {
        readFileSync(file)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
      }
      for (const e of Object.values(readLock(file).packages))
        if (e.source.type === "git") urls.add(e.source.url)
    } catch {
      unreadable.push(file)
    }
  }
  return { urls: [...urls], unreadable }
}

function mtimeOf(p: string): number {
  try {
    return lstatSync(p).mtimeMs
  } catch {
    return 0
  }
}

function removeStaleClones(cacheDir: string, dryRun: boolean): GitCacheEntry[] {
  let names: string[]
  try {
    names = readdirSync(cacheDir)
  } catch {
    return []
  }
  const removed: GitCacheEntry[] = []
  for (const n of names.sort()) {
    const match = /^([0-9a-f]{24})\.git\.tmp-(\d+)$/.exec(n)
    if (!match || isProcessAlive(Number(match[2]))) continue
    const dir = path.join(cacheDir, n)
    const bytes = sizeOf(dir)
    if (!dryRun) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    removed.push({ key: match[1]!, dir, bytes })
  }
  return removed
}
