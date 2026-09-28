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
import { type IndexOptions, loadIndex } from "./index-file.ts"
import {
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

export interface UpdateResult {
  name: string
  from: LockEntry
  to: LockEntry
  /** Whether a different commit or version was installed. */
  changed: boolean
}

/**
 * Fetches the newest files each source offers (a branch's head, the highest matching npm
 * version, a path's current contents; index entries are looked up again) and re-pins.
 */
export async function updatePackages(opts: InstallOptions, names?: string[]): Promise<UpdateResult[]> {
  const lock = readLock(opts.scope.lockFile)
  const selected = names?.length ? names : Object.keys(lock.packages)
  for (const n of selected) {
    if (!lock.packages[n]) throw new PackageError(`"${n}" is not installed in the ${opts.scope.kind} scope`)
  }
  const out: UpdateResult[] = []
  for (const name of selected) {
    const from = lock.packages[name]!
    let source = from.source
    let index = from.index
    if (from.index) {
      const loaded = await loadIndex({ ...opts.index, url: from.index.url })
      const e = loaded.index.extensions.find((x) => x.name === from.index!.name)
      if (e) source = e.source
      else opts.log?.(`${name}: no longer in the extensions index; updating from its recorded source`)
      index = { name: from.index.name, url: loaded.url }
    }
    const r = await install(source, { expectName: name, ...(index ? { index } : {}) }, opts)
    out.push({ name, from, to: r.entry, changed: pinKey(from) !== pinKey(r.entry) })
  }
  return out
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
}

async function install(source: PackageSource, how: InstallHow, opts: InstallOptions): Promise<InstallResult> {
  mkdirSync(opts.scope.dir, { recursive: true })
  // Inside the scope directory so the final rename stays on one volume.
  const work = mkdtempSync(path.join(opts.scope.dir, ".work-"))
  try {
    const { root, pinned } = await fetchSource(source, how.pinned, work, opts)
    const manifest = readManifest(root)
    if (how.expectName && manifest.name !== how.expectName) {
      throw new PackageError(
        `expected a package named "${how.expectName}", but ${root} is "${manifest.name}"`,
      )
    }
    const mismatch = engineMismatch(manifest)
    if (mismatch) throw new PackageError(mismatch)
    const staged = path.join(work, "package")
    cpSync(root, staged, {
      recursive: true,
      filter: (src) => src === root || !SKIPPED.has(path.basename(src)),
    })
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

/** Version control data and dependencies are not copied; dependencies are installed afresh. */
const SKIPPED = new Set([".git", "node_modules"])

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

function pinKey(e: LockEntry): string {
  return `${e.version} ${e.pinned.commit ?? ""} ${e.pinned.version ?? ""} ${e.pinned.integrity ?? ""}`
}

async function fetchSource(
  source: PackageSource,
  pin: LockEntry["pinned"] | undefined,
  work: string,
  opts: InstallOptions,
): Promise<{ root: string; pinned: LockEntry["pinned"] }> {
  if (source.type === "path") {
    if (!existsSync(source.path)) throw new PackageError(`${source.path} does not exist`)
    return { root: source.path, pinned: {} }
  }
  if (source.type === "git") return fetchGit(source, pin, work, opts)
  return fetchNpm(source.spec, pin, work, opts)
}

async function fetchGit(
  source: Extract<PackageSource, { type: "git" }>,
  pin: LockEntry["pinned"] | undefined,
  work: string,
  opts: InstallOptions,
): Promise<{ root: string; pinned: LockEntry["pinned"] }> {
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
  if (!existsSync(root)) throw new PackageError(`${source.url} has no directory ${source.path}`)
  return { root, pinned: { commit } }
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
