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
import { runCommand } from "@amira/proc"
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
  /** Progress lines, e.g. "cloning ...". */
  log?: (line: string) => void
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

/** Git clones, npm downloads and dependency installs may be slow, but not endless. */
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Installs a package into a scope and records the exact commit or version in its lock
 * file (D24, D49, D60). The files are prepared next to the scope and swapped in at the end,
 * so a failed install leaves the previous one untouched.
 */
export async function installPackage(spec: string, opts: InstallOptions): Promise<InstallResult> {
  const parsed: InstallSpec = parseSpec(spec, opts.cwd)
  if (parsed.type !== "name") return install(parsed, {}, opts)
  return installFromIndex(parsed.name, opts)
}

async function installFromIndex(name: string, opts: InstallOptions): Promise<InstallResult> {
  const { index, url, warnings } = await loadIndex(opts.index)
  const entry = index.extensions.find((e) => e.name === name)
  if (!entry) {
    throw new PackageError(
      `"${name}" is not in the extensions index (${url}); see amira ext search, or use npm:${name} for an npm package`,
    )
  }
  const result = await install(entry.source, { expectName: name, index: { name, url } }, opts)
  return { ...result, warnings: [...warnings, ...result.warnings] }
}

/** Installs every package of the lock file that is missing, at its pinned commit or version. */
export async function restorePackages(opts: InstallOptions): Promise<InstallResult[]> {
  const lock = readLock(opts.scope.lockFile)
  const out: InstallResult[] = []
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (existsSync(packageDir(opts.scope, name))) continue
    out.push(await install(entry.source, { expectName: name, pinned: entry.pinned, keep: entry }, opts))
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
export async function updatePackages(opts: InstallOptions, names?: string[]): Promise<UpdateResult[]> {
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
    const from = lock.packages[name]!
    try {
      let source = from.source
      let index = from.index
      if (from.index) {
        const loaded = await readIndex(from.index.url)
        const e = loaded.index.extensions.find((x) => x.name === from.index!.name)
        if (e) source = e.source
        else
          opts.log?.(
            `warning: ${name} is no longer in the extensions index; updating from its recorded source`,
          )
        index = { name: from.index.name, url: loaded.url }
      }
      const r = await install(source, { expectName: name, ...(index ? { index } : {}), current: from }, opts)
      out.push({ name, from, to: r.entry, changed: pinKey(from) !== pinKey(r.entry) })
    } catch (err) {
      // Stopped (Ctrl+C): do not go on to the next package.
      if (opts.signal?.aborted) throw err
      out.push({ name, from, error: errorMessage(err) })
    }
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
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  if (lock.packages[name]) {
    delete lock.packages[name]
    writeLock(scope.lockFile, lock)
  }
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

async function install(source: PackageSource, how: InstallHow, opts: InstallOptions): Promise<InstallResult> {
  mkdirSync(opts.scope.dir, { recursive: true })
  removeStaleWork(opts.scope.dir)
  // Inside the scope directory so the final rename stays on one volume.
  const work = mkdtempSync(path.join(opts.scope.dir, `.work-${process.pid}-`))
  try {
    const { root, pinned, sameTree } = await fetchSource(
      source,
      how.pinned,
      work,
      opts,
      how.current?.pinned.commit,
    )
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
    const current = how.current
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
    copyTree(root, staged, (src) => isWithin(src, staged) || (scopeInside && isWithin(src, opts.scope.dir)))
    if (manifest.hasDependencies) await installDependencies(staged, opts)
    const lock = readLock(opts.scope.lockFile)
    const previous = lock.packages[manifest.name]
    const entry: LockEntry = how.keep ?? {
      version: manifest.version,
      source,
      ...(how.index ? { index: how.index } : {}),
      pinned,
      installedAt: new Date().toISOString(),
    }
    swapIn(staged, packageDir(opts.scope, manifest.name), work)
    lock.packages[manifest.name] = entry
    writeLock(opts.scope.lockFile, lock)
    return { name: manifest.name, entry, ...(previous ? { previous } : {}), manifest, warnings: [] }
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 })
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
    if (pid && !isAlive(Number(pid)))
      rmSync(path.join(scopeDir, n), { recursive: true, force: true, maxRetries: 3 })
  }
}

function isAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

function swapIn(staged: string, dest: string, work: string) {
  mkdirSync(path.dirname(dest), { recursive: true })
  const old = path.join(work, "previous")
  if (existsSync(dest)) renameSync(dest, old)
  try {
    renameSync(staged, dest)
  } catch (err) {
    if (existsSync(old)) renameSync(old, dest)
    throw err
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

async function fetchSource(
  source: PackageSource,
  pin: LockEntry["pinned"] | undefined,
  work: string,
  opts: InstallOptions,
  /** The commit installed now, when updating. */
  since?: string,
): Promise<{ root: string; pinned: LockEntry["pinned"]; sameTree?: boolean }> {
  if (source.type === "path") {
    if (!existsSync(source.path)) throw new PackageError(`${source.path} does not exist`)
    return { root: source.path, pinned: {} }
  }
  if (source.type === "git") return fetchGit(source, pin, work, opts, since)
  return fetchNpm(source.spec, pin, work, opts)
}

async function fetchGit(
  source: Extract<PackageSource, { type: "git" }>,
  pin: LockEntry["pinned"] | undefined,
  work: string,
  opts: InstallOptions,
  since?: string,
): Promise<{ root: string; pinned: LockEntry["pinned"]; sameTree?: boolean }> {
  const clone = path.join(work, "clone")
  opts.log?.(`cloning ${source.url}`)
  await run(["git", "clone", "--quiet", "--", source.url, clone], work, opts, "git clone")
  const want = pin?.commit ?? source.ref
  let commit: string
  if (want) {
    if (want.startsWith("-")) throw new PackageError(`not a git ref: ${want}`)
    // A branch other than the default exists only as origin/<branch> in a fresh clone.
    commit = (await revParse(clone, want, opts)) ?? (await revParse(clone, `origin/${want}`, opts)) ?? ""
    if (!commit) throw new PackageError(`${source.url} has no branch, tag or commit "${want}"`)
    await run(["git", "checkout", "--quiet", "--detach", commit], clone, opts, `git checkout ${want}`)
  } else {
    commit = (await run(["git", "rev-parse", "HEAD"], clone, opts, "git rev-parse", true)).trim()
  }
  const root = source.path ? path.join(clone, source.path) : clone
  if (!isWithin(root, clone))
    throw new PackageError(`${source.url}: path ${source.path} is outside the repository`)
  if (!existsSync(root)) throw new PackageError(`${source.url} has no directory ${source.path}`)
  // A package in a subdirectory: whether its files are the same as at the installed commit.
  // Only a full object id: an abbreviated one could be taken for a branch of that name.
  let sameTree: boolean | undefined
  if (source.path && since && since !== commit && /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(since)) {
    const sub = source.path.replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "")
    const [before, after] = await Promise.all([
      treeOf(clone, `${since}:${sub}`, opts),
      treeOf(clone, `${commit}:${sub}`, opts),
    ])
    sameTree = before !== undefined && before === after
  }
  return { root, pinned: { commit }, ...(sameTree !== undefined ? { sameTree } : {}) }
}

/** The object id of `<commit>:<path>`, if the clone has it. */
async function treeOf(clone: string, spec: string, opts: InstallOptions): Promise<string | undefined> {
  try {
    const out = await run(["git", "rev-parse", "--verify", "--quiet", spec], clone, opts, "", true)
    return out.trim() || undefined
  } catch {
    return undefined
  }
}

async function revParse(clone: string, ref: string, opts: InstallOptions): Promise<string | undefined> {
  try {
    const out = await run(
      ["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      clone,
      opts,
      "",
      true,
    )
    return out.trim() || undefined
  } catch {
    return undefined
  }
}

async function fetchNpm(
  spec: string,
  pin: LockEntry["pinned"] | undefined,
  work: string,
  opts: InstallOptions,
): Promise<{ root: string; pinned: LockEntry["pinned"] }> {
  const { name, range } = splitNpmSpec(spec)
  const registry = (
    opts.npmRegistry ??
    process.env.npm_config_registry ??
    "https://registry.npmjs.org"
  ).replace(/\/+$/, "")
  const get = opts.fetch ?? fetch
  opts.log?.(`resolving ${name}@${range} on ${registry}`)
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
  // Relative names: GNU tar reads "C:" in a path as a remote host.
  await run([tarProgram(), "-xzf", path.join("..", "package.tgz")], out, opts, "tar")
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
  opts.log?.("installing dependencies")
  await run([process.execPath, "install", "--production"], dir, opts, "bun install", false, {
    BUN_BE_BUN: "1",
  })
}

async function run(
  argv: string[],
  cwd: string,
  opts: InstallOptions,
  what: string,
  stdoutOnly = false,
  env: Record<string, string> = {},
): Promise<string> {
  const r = await runCommand(argv, {
    cwd,
    timeoutMs: COMMAND_TIMEOUT_MS,
    signal: opts.signal ?? new AbortController().signal,
    // Never wait for a credential prompt nobody can see.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    ...(stdoutOnly ? { stdoutOnly: true } : {}),
    // Windows: Bun stalls for seconds on some direct spawns of git.
    ...(argv[0] === "git" ? { viaCmd: true } : {}),
  })
  if (r.exitCode === 0) return r.output
  const why = r.timedOut
    ? "timed out"
    : r.aborted
      ? "was cancelled"
      : `failed (exit ${r.exitCode ?? r.signalCode})`
  const output = r.output.trim().split(/\r?\n/).slice(-8).join("\n")
  throw new PackageError(`${what} ${why}${output ? `:\n${output}` : ""}`)
}

function timeout(opts: InstallOptions): AbortSignal {
  const t = AbortSignal.timeout(COMMAND_TIMEOUT_MS)
  return opts.signal ? AbortSignal.any([opts.signal, t]) : t
}
