import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { isProcessAlive } from "@amira/core"
import { defaultGitCacheDir, GitCache, type GitContext, type GitPhase, isFullCommitId } from "./git-cache.ts"
import { type IndexOptions, type LoadedIndex, loadIndex } from "./index-file.ts"
import {
  describeSource,
  type LockEntry,
  type PackageScope,
  type PackageSource,
  packageDir,
  readLock,
  writeLock,
} from "./lock.ts"
import { engineMismatch, PackageError, type PackageManifest, readManifest } from "./manifest.ts"
import { COMMAND_TIMEOUT_MS, runTool } from "./run.ts"
import { type InstallSpec, parseSpec, splitNpmSpec } from "./source.ts"

export interface InstallOptions {
  scope: PackageScope
  /** Relative paths in specs are resolved against this. */
  cwd: string
  /** Where names are looked up. */
  index?: IndexOptions
  /** Downloads from the npm registry. */
  fetch?: typeof fetch
  /** Default $npm_config_registry, then https://registry.npmjs.org. */
  npmRegistry?: string
  signal?: AbortSignal
  /** Warnings, e.g. that the index or a repository could not be reached and a cache was used. */
  log?: (line: string) => void
  /** What each package is doing, for a progress display. */
  onProgress?: (p: InstallProgress) => void
  /** Where git repositories are cached (whatever the scope). Default ~/.amira/cache/git. */
  cacheDir?: string
  /**
   * Shared by the packages of one command, so that each repository is asked and fetched once.
   * Made per call when absent.
   */
  gitCache?: GitCache
}

export type InstallPhase = GitPhase | "copying" | "verifying" | "dependencies"

export interface InstallProgress {
  /** The package's name, or the spec it is being installed from. */
  name: string
  phase: InstallPhase
  /** E.g. the repository being fetched. */
  detail?: string
  /** 0 to 100, when the phase reports it. */
  percent?: number
}

type Report = (phase: InstallPhase, detail?: string, percent?: number) => void

function reporter(opts: InstallOptions, name: string): Report {
  return (phase, detail, percent) =>
    opts.onProgress?.({
      name,
      phase,
      ...(detail !== undefined ? { detail } : {}),
      ...(percent !== undefined ? { percent } : {}),
    })
}

function withGitCache(opts: InstallOptions): InstallOptions {
  return opts.gitCache ? opts : { ...opts, gitCache: new GitCache(opts.cacheDir ?? defaultGitCacheDir()) }
}

export interface InstallResult {
  name: string
  entry: LockEntry
  /** The lock entry this install replaced, if the package was already there. */
  previous?: LockEntry
  manifest: PackageManifest
  /** Messages worth showing, e.g. from the index. */
  warnings: string[]
}

/**
 * Installs a package into a scope and records the exact commit or version in its lock
 * file (D24, D49, D60). The files are prepared next to the scope and swapped in at the end,
 * so a failed install leaves the previous one untouched.
 */
export async function installPackage(spec: string, opts: InstallOptions): Promise<InstallResult> {
  opts = withGitCache(opts)
  const report = reporter(opts, spec)
  const parsed: InstallSpec = parseSpec(spec, opts.cwd)
  if (parsed.type !== "name") return install(parsed, {}, opts, report)
  return installFromIndex(parsed.name, opts, report)
}

async function installFromIndex(name: string, opts: InstallOptions, report: Report): Promise<InstallResult> {
  report("resolving", "extensions index")
  const { index, url, warnings } = await loadIndex(opts.index)
  const entry = index.extensions.find((e) => e.name === name)
  if (!entry) {
    throw new PackageError(
      `"${name}" is not in the extensions index (${url}); see amira ext search, or use npm:${name} for an npm package`,
    )
  }
  const result = await install(entry.source, { expectName: name, index: { name, url } }, opts, report)
  return { ...result, warnings: [...warnings, ...result.warnings] }
}

/** The lock file's packages whose files are missing: what restorePackages would install. */
export function missingPackages(scope: PackageScope): string[] {
  const lock = readLock(scope.lockFile)
  return Object.keys(lock.packages).filter((name) => !existsSync(packageDir(scope, name)))
}

/** Installs every package of the lock file that is missing, at its pinned commit or version. */
export async function restorePackages(
  opts: InstallOptions,
  each?: (r: InstallResult) => void,
): Promise<InstallResult[]> {
  opts = withGitCache(opts)
  const lock = readLock(opts.scope.lockFile)
  const out: InstallResult[] = []
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (existsSync(packageDir(opts.scope, name))) continue
    opts.signal?.throwIfAborted()
    const r = await install(
      entry.source,
      { expectName: name, pinned: entry.pinned, keep: entry },
      opts,
      reporter(opts, name),
    )
    each?.(r)
    out.push(r)
  }
  return out
}

/** One package's update: what it moved to, or why it could not (the installed one is kept). */
export type UpdateResult =
  | {
      name: string
      from: LockEntry
      to: LockEntry
      /** Whether a different commit or version was installed. */
      changed: boolean
    }
  | { name: string; from: LockEntry; error: string }

/**
 * Fetches the newest files each source offers (a branch's head, the highest matching npm
 * version, a path's current contents; index entries are looked up again, bypassing the
 * index cache) and re-pins. A package whose pin did not move is left as it is. A package
 * that fails keeps its installed files and lock entry, and the others are still updated.
 */
export async function updatePackages(
  opts: InstallOptions,
  names?: string[],
  each?: (r: UpdateResult) => void,
): Promise<UpdateResult[]> {
  opts = withGitCache(opts)
  const lock = readLock(opts.scope.lockFile)
  const selected = names?.length ? names : Object.keys(lock.packages)
  for (const n of selected) {
    if (!lock.packages[n]) throw new PackageError(`"${n}" is not installed in the ${opts.scope.kind} scope`)
  }
  /**
   * Each index once per update, by URL. A package from an index is not updated without it: the
   * index may have moved the package away from the source it was installed from.
   */
  const indexes = new Map<string, Promise<LoadedIndex>>()
  const readIndex = (url: string) => {
    let p = indexes.get(url)
    if (!p) {
      p = loadIndex({ ...opts.index, refresh: true, url })
      p.then(
        (loaded) => {
          for (const w of loaded.warnings) opts.log?.(`warning: ${w}`)
        },
        () => {},
      )
      indexes.set(url, p)
    }
    return p
  }
  const out: UpdateResult[] = []
  for (const name of selected) {
    opts.signal?.throwIfAborted()
    const from = lock.packages[name]!
    const report = reporter(opts, name)
    let result: UpdateResult
    try {
      let source = from.source
      let index = from.index
      if (from.index) {
        report("resolving", "extensions index")
        const loaded = await readIndex(from.index.url)
        const e = loaded.index.extensions.find((x) => x.name === from.index!.name)
        if (e) source = e.source
        else
          opts.log?.(
            `warning: ${name} is no longer in the extensions index; updating from its recorded source`,
          )
        index = { name: from.index.name, url: loaded.url }
      }
      const r = await install(
        source,
        { expectName: name, ...(index ? { index } : {}), current: from },
        opts,
        report,
      )
      result = { name, from, to: r.entry, changed: pinKey(from) !== pinKey(r.entry) }
    } catch (err) {
      // Stopped (Ctrl+C): do not go on to the next package.
      if (opts.signal?.aborted) throw err
      result = { name, from, error: errorMessage(err) }
    }
    each?.(result)
    out.push(result)
  }
  return out
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Deletes the package's files and lock entry; false if it was not installed in this scope. */
export function removePackage(name: string, scope: PackageScope): boolean {
  const lock = readLock(scope.lockFile)
  const dir = packageDir(scope, name)
  const known = !!lock.packages[name] || existsSync(dir)
  // The lock first: files it no longer records are inert (nothing loads them), and a second
  // remove deletes them; files it still records but that are gone would be restored.
  if (lock.packages[name]) {
    delete lock.packages[name]
    writeLock(scope.lockFile, lock)
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  return known
}

interface InstallHow {
  /** The package must have this name (index entries, lock entries). */
  expectName?: string
  pinned?: LockEntry["pinned"]
  index?: { name: string; url: string }
  /** Restoring: keep this entry's record rather than writing a new one. */
  keep?: LockEntry
  /**
   * Updating: the installed entry. When the fetched pin, version and source are the same and
   * the files are there, nothing is swapped in and the lock is not rewritten.
   */
  current?: LockEntry
}

async function install(
  source: PackageSource,
  how: InstallHow,
  opts: InstallOptions,
  report: Report,
): Promise<InstallResult> {
  mkdirSync(opts.scope.dir, { recursive: true })
  removeStaleWork(opts.scope.dir)
  // Inside the scope directory so the final rename stays on one volume.
  const work = mkdtempSync(path.join(opts.scope.dir, `.work-${process.pid}-`))
  let keepWork = false
  try {
    const current = how.current
    // Updating a package that stays where it was: a git source whose commit did not move need
    // not be downloaded at all.
    const installedDir = how.expectName ? packageDir(opts.scope, how.expectName) : undefined
    const mayKeep =
      !!current &&
      !!installedDir &&
      sameJson(current.source, source) &&
      sameJson(current.index, how.index) &&
      existsSync(installedDir)
    const fetched = await fetchSource(source, how.pinned, work, opts, report, current?.pinned.commit, mayKeep)
    if ("kept" in fetched && current && installedDir) {
      report("verifying")
      const manifest = readManifest(installedDir)
      return { name: manifest.name, entry: current, previous: current, manifest, warnings: [] }
    }
    const { root, pinned, sameTree } = fetched as Fetched
    report("verifying")
    // A clone or download lives in the work directory, whose name means nothing to the user.
    const where = isWithin(root, work) ? describeSource(source) : root
    let manifest: PackageManifest
    try {
      manifest = readManifest(root)
    } catch (err) {
      if (!(err instanceof PackageError) || where === root) throw err
      const hint =
        source.type === "git" && !source.path
          ? " (a package in a subdirectory of a repository installs by its name from the extensions index)"
          : ""
      throw new PackageError(`${err.message.split(root).join(where)}${hint}`)
    }
    if (how.expectName && manifest.name !== how.expectName) {
      throw new PackageError(
        `expected a package named "${how.expectName}", but ${where} is "${manifest.name}"`,
      )
    }
    const mismatch = engineMismatch(manifest)
    if (mismatch) throw new PackageError(mismatch)
    if (
      current &&
      (pinned.commit || pinned.version) &&
      // The same pin; or, for a package in a repository's subdirectory, other parts of the
      // repository moved on while its own files stayed the same (the older pin is kept).
      (pinKey(current) === pinKey({ ...current, version: manifest.version, pinned }) ||
        (sameTree === true && current.version === manifest.version)) &&
      sameJson(current.source, source) &&
      sameJson(current.index, how.index) &&
      existsSync(packageDir(opts.scope, manifest.name))
    ) {
      return { name: manifest.name, entry: current, previous: current, manifest, warnings: [] }
    }
    const staged = path.join(work, "package")
    // The source may contain the scope itself (`amira ext install --project .` in a package's
    // own repository), so the scope directory is skipped rather than copied into itself.
    // Clones and npm downloads live in the work directory, inside the scope: never skip those.
    const scopeInside = !isWithin(root, opts.scope.dir)
    report("copying")
    copyTree(root, staged, (src) => isWithin(src, staged) || (scopeInside && isWithin(src, opts.scope.dir)))
    if (manifest.hasDependencies) {
      report("dependencies")
      await installDependencies(staged, opts)
    }
    const lock = readLock(opts.scope.lockFile)
    const previous = lock.packages[manifest.name]
    const entry: LockEntry = how.keep ?? {
      version: manifest.version,
      source,
      ...(how.index ? { index: how.index } : {}),
      pinned,
      installedAt: new Date().toISOString(),
    }
    // The swap and the lock are one change: the previous files are kept in the work directory
    // until the lock records the new ones, and put back if it cannot.
    const undo = swapIn(staged, packageDir(opts.scope, manifest.name), work)
    lock.packages[manifest.name] = entry
    try {
      writeLock(opts.scope.lockFile, lock)
    } catch (err) {
      try {
        undo()
      } catch (undoErr) {
        keepWork = true
        throw new PackageError(
          `${errorMessage(err)}; the previous files of ${manifest.name} could not be put back ` +
            `(${errorMessage(undoErr)}) and are kept in ${path.join(work, "previous")}`,
        )
      }
      throw err
    }
    return { name: manifest.name, entry, ...(previous ? { previous } : {}), manifest, warnings: [] }
  } finally {
    if (!keepWork) rmSync(work, { recursive: true, force: true, maxRetries: 3 })
  }
}

/**
 * Version control data and dependencies are not copied (dependencies are installed afresh),
 * nor a project's own `.amira` (sessions, local settings, packages).
 */
const SKIPPED = new Set([".git", "node_modules", ".amira"])

/** Copies by hand: cpSync refuses a destination inside the source even when a filter skips it. */
function copyTree(src: string, dest: string, skip: (src: string) => boolean) {
  mkdirSync(dest, { recursive: true })
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name)
    if (SKIPPED.has(e.name) || skip(from)) continue
    const to = path.join(dest, e.name)
    if (e.isDirectory()) copyTree(from, to, skip)
    else cpSync(from, to)
  }
}

function isWithin(p: string, dir: string): boolean {
  const rel = path.relative(dir, p)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/**
 * Work directories carry the installing process's pid, so ones left by an interrupted
 * install (Ctrl+C during a long clone) can be told apart from a concurrent install.
 */
function removeStaleWork(scopeDir: string) {
  let names: string[]
  try {
    names = readdirSync(scopeDir)
  } catch {
    return
  }
  for (const n of names) {
    const pid = /^\.work-(\d+)-/.exec(n)?.[1]
    if (pid && !isProcessAlive(Number(pid)))
      rmSync(path.join(scopeDir, n), { recursive: true, force: true, maxRetries: 3 })
  }
}

/**
 * Moves the staged files into place, the installed ones (if any) to `work/previous`. Returns
 * what undoes it: the new files go back into the work directory and the previous ones return.
 */
function swapIn(staged: string, dest: string, work: string): () => void {
  mkdirSync(path.dirname(dest), { recursive: true })
  const old = path.join(work, "previous")
  const hadOld = existsSync(dest)
  if (hadOld) renameSync(dest, old)
  try {
    renameSync(staged, dest)
  } catch (err) {
    if (hadOld) renameSync(old, dest)
    throw err
  }
  return () => {
    renameSync(dest, path.join(work, "undone"))
    if (hadOld) renameSync(old, dest)
  }
}

/** Equal as JSON, whatever the key order (lock files are hand-edited). */
function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([, x]) => x !== undefined)
            .sort(([x], [y]) => x.localeCompare(y))
            .map(([k, x]) => [k, norm(x)]),
        )
      : v
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

function pinKey(e: LockEntry): string {
  return `${e.version} ${e.pinned.commit ?? ""} ${e.pinned.version ?? ""} ${e.pinned.integrity ?? ""}`
}

interface Fetched {
  root: string
  pinned: LockEntry["pinned"]
  sameTree?: boolean
}

/** The installed files can stay: the source still has the installed commit (or its files). */
interface Kept {
  kept: true
}

async function fetchSource(
  source: PackageSource,
  pin: LockEntry["pinned"] | undefined,
  work: string,
  opts: InstallOptions,
  report: Report,
  /** The commit installed now, when updating. */
  since?: string,
  /** Updating a package whose source did not change: its files may be kept. */
  mayKeep = false,
): Promise<Fetched | Kept> {
  if (source.type === "path") {
    if (!existsSync(source.path)) throw new PackageError(`${source.path} does not exist`)
    return { root: source.path, pinned: {} }
  }
  if (source.type === "git") return fetchGit(source, pin, work, opts, report, since, mayKeep)
  return fetchNpm(source.spec, pin, work, opts, report)
}

/** A subdirectory of a repository as git names it: forward slashes, no `.` parts. */
function repoSubdir(source: Extract<PackageSource, { type: "git" }>): string {
  if (!source.path) return ""
  const raw = source.path.replace(/\\/g, "/")
  const parts = raw.split("/").filter((p) => p && p !== ".")
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || parts.includes(".."))
    throw new PackageError(`${source.url}: path ${source.path} is outside the repository`)
  return parts.join("/")
}

async function fetchGit(
  source: Extract<PackageSource, { type: "git" }>,
  pin: LockEntry["pinned"] | undefined,
  work: string,
  opts: InstallOptions,
  report: Report,
  since?: string,
  mayKeep = false,
): Promise<Fetched | Kept> {
  const cache = opts.gitCache ?? new GitCache(opts.cacheDir ?? defaultGitCacheDir())
  const sub = repoSubdir(source)
  const ctx: GitContext = {
    progress: report,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  }
  // Only a full object id: an abbreviated one could be taken for a branch of that name.
  const installed = since && isFullCommitId(since) ? since.toLowerCase() : undefined
  const keepable = mayKeep && installed !== undefined && !pin?.commit
  // Updating: when the remote still points at the installed commit, nothing is downloaded.
  if (keepable) {
    const ref = source.ref
    if (ref && isFullCommitId(ref)) {
      if (ref.toLowerCase() === installed) return { kept: true }
    } else {
      const remote = await cache.remoteCommit(source.url, ref, ctx)
      if (!("unreachable" in remote) && remote.commit?.toLowerCase() === installed) return { kept: true }
    }
  }
  return cache.withCommit(
    {
      url: source.url,
      ...(pin?.commit ? { commit: pin.commit } : {}),
      ...(source.ref ? { ref: source.ref } : {}),
      requireRemote: since !== undefined,
    },
    ctx,
    async (repo): Promise<Fetched | Kept> => {
      const commit = repo.commit
      if (keepable && commit === installed) return { kept: true }
      // A package in a subdirectory: whether its files are the same as at the installed commit.
      let sameTree: boolean | undefined
      if (sub && installed && installed !== commit) {
        const [before, after] = await repo.treesOf([`${installed}:${sub}`, `${commit}:${sub}`])
        sameTree = before !== undefined && before === after
        // Other parts of the repository moved on; its own files are the same (the older pin is kept).
        if (sameTree && keepable) return { kept: true }
      }
      const root = path.join(work, "src")
      await repo.materialize(sub, root, path.join(work, "index"))
      return { root, pinned: { commit }, ...(sameTree !== undefined ? { sameTree } : {}) }
    },
  )
}

async function fetchNpm(
  spec: string,
  pin: LockEntry["pinned"] | undefined,
  work: string,
  opts: InstallOptions,
  report: Report,
): Promise<Fetched> {
  const { name, range } = splitNpmSpec(spec)
  const registry = (
    opts.npmRegistry ??
    process.env.npm_config_registry ??
    "https://registry.npmjs.org"
  ).replace(/\/+$/, "")
  const get = opts.fetch ?? fetch
  report("resolving", `${name}@${range}`)
  const res = await get(`${registry}/${name.replace("/", "%2f")}`, { signal: timeout(opts) })
  if (!res.ok) throw new PackageError(`npm: cannot fetch ${name} (HTTP ${res.status})`)
  const meta = (await res.json()) as { "dist-tags"?: Record<string, string>; versions?: Record<string, any> }
  const versions = Object.keys(meta.versions ?? {})
  const version =
    pin?.version ??
    meta["dist-tags"]?.[range] ??
    versions
      .filter((v) => Bun.semver.satisfies(v, range))
      .sort(Bun.semver.order)
      .at(-1)
  const dist = version ? meta.versions?.[version]?.dist : undefined
  if (!version || typeof dist?.tarball !== "string")
    throw new PackageError(`npm: no version of ${name} matches ${range}`)
  const integrity: string | undefined = typeof dist.integrity === "string" ? dist.integrity : undefined
  if (pin?.integrity && integrity && pin.integrity !== integrity) {
    throw new PackageError(`npm: ${name}@${version} changed on the registry since it was pinned`)
  }
  report("fetching", `${name}@${version}`)
  const tar = await get(dist.tarball, { signal: timeout(opts) })
  if (!tar.ok) throw new PackageError(`npm: cannot download ${dist.tarball} (HTTP ${tar.status})`)
  const bytes = new Uint8Array(await tar.arrayBuffer())
  if (integrity?.startsWith("sha512-")) {
    const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
    if (actual !== integrity) throw new PackageError(`npm: ${name}@${version} failed its integrity check`)
  }
  writeFileSync(path.join(work, "package.tgz"), bytes)
  const out = path.join(work, "npm")
  mkdirSync(out)
  report("extracting")
  // Relative names: GNU tar reads "C:" in a path as a remote host.
  await runTool([tarProgram(), "-xzf", path.join("..", "package.tgz")], out, "tar", runOpts(opts))
  const [top] = readdirSync(out)
  if (!top) throw new PackageError(`npm: ${name}@${version} is an empty tarball`)
  return {
    root: path.join(out, top),
    pinned: { version, ...(integrity ? { integrity } : {}) },
  }
}

/** Windows ships bsdtar, which unpacks .tgz; Git's GNU tar may come first on PATH. */
function tarProgram(): string {
  if (process.platform !== "win32") return "tar"
  const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  return existsSync(system) ? system : "tar"
}

/**
 * `bun install --production` in the package. A compiled Amira behaves as bun with
 * BUN_BE_BUN set, so this works without a separate Bun installation.
 */
async function installDependencies(dir: string, opts: InstallOptions) {
  await runTool([process.execPath, "install", "--production"], dir, "bun install", {
    ...runOpts(opts),
    env: { BUN_BE_BUN: "1" },
  })
}

function runOpts(opts: InstallOptions): { signal?: AbortSignal } {
  return opts.signal ? { signal: opts.signal } : {}
}

function timeout(opts: InstallOptions): AbortSignal {
  const t = AbortSignal.timeout(COMMAND_TIMEOUT_MS)
  return opts.signal ? AbortSignal.any([opts.signal, t]) : t
}
