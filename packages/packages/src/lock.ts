import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { amiraHome, projectAmiraDir } from "@amira/core"
import { isValidPackageName, PackageError } from "./manifest.ts"

export type ScopeKind = "user" | "project"

/** Where one scope keeps its packages (D60): `~/.amira` or `<project>/.amira`. */
export interface PackageScope {
  kind: ScopeKind
  /** Installed packages, one directory per name. */
  dir: string
  /** The scope's lock file; commit the project one so others can `amira ext install --project`. */
  lockFile: string
}

export function packageScope(kind: ScopeKind, where: { home?: string; cwd: string }): PackageScope {
  const root = kind === "user" ? (where.home ?? amiraHome()) : projectAmiraDir(where.cwd)
  return { kind, dir: path.join(root, "packages"), lockFile: path.join(root, "packages.lock") }
}

/** Where a package's files come from; enough to fetch the same files again. */
export type PackageSource =
  | { type: "path"; path: string }
  | { type: "git"; url: string; ref?: string; path?: string }
  | { type: "npm"; spec: string }

/** One installed package as the lock file records it. */
export interface LockEntry {
  version: string
  source: PackageSource
  /** Set when the package was found through an extensions index: `amira ext update` asks it again. */
  index?: { name: string; url: string }
  /** What was actually installed: the git commit, or the npm version and tarball integrity. */
  pinned: { commit?: string; version?: string; integrity?: string }
  installedAt: string
}

export interface LockFile {
  lockfileVersion: 1
  packages: Record<string, LockEntry>
}

export function readLock(file: string): LockFile {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return { lockfileVersion: 1, packages: {} }
  }
  let v: any
  try {
    v = JSON.parse(text)
  } catch {
    throw new PackageError(`${file}: not valid JSON`)
  }
  if (v?.lockfileVersion !== 1 || typeof v.packages !== "object" || v.packages === null) {
    throw new PackageError(`${file}: not an Amira packages lock file (lockfileVersion 1)`)
  }
  for (const [name, entry] of Object.entries(v.packages)) {
    const problem = entryProblem(name, entry)
    if (problem) throw new PackageError(`${file}: entry "${name}" ${problem}`)
  }
  return v as LockFile
}

/** Lock files are committed and hand-edited; later code relies on these fields being there. */
function entryProblem(name: string, e: any): string | undefined {
  if (!isValidPackageName(name)) return "is not a package name"
  if (typeof e !== "object" || e === null) return "is not an object"
  if (typeof e.version !== "string") return 'has no "version"'
  const s = e.source
  const sourceOk =
    (s?.type === "path" && typeof s.path === "string") ||
    (s?.type === "git" && typeof s.url === "string") ||
    (s?.type === "npm" && typeof s.spec === "string")
  if (!sourceOk) return 'has no valid "source" (path, git or npm)'
  // A git package's subdirectory stays inside the repository, as in the index.
  if (s.type === "git" && s.path !== undefined) {
    if (typeof s.path !== "string" || s.path.split(/[\\/]/).includes("..") || path.isAbsolute(s.path))
      return 'has a git "path" outside the repository'
  }
  if (typeof e.pinned !== "object" || e.pinned === null) return 'has no "pinned" object'
  if (e.index !== undefined && (typeof e.index?.name !== "string" || typeof e.index?.url !== "string"))
    return 'has an invalid "index"'
  return undefined
}

/** Written through a temporary file, with names sorted so diffs stay small. */
export function writeLock(file: string, lock: LockFile): void {
  const sorted: LockFile = {
    lockfileVersion: 1,
    packages: Object.fromEntries(Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))),
  }
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`)
  try {
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * The directory a package of this name is installed in; scoped npm names nest one level.
 * Names come from the command line and hand-edited lock files, and the result is deleted
 * recursively, so anything that is not a package name is refused.
 */
export function packageDir(scope: PackageScope, name: string): string {
  if (!isValidPackageName(name)) throw new PackageError(`"${name}" is not a package name`)
  return path.join(scope.dir, ...name.split("/"))
}

/** How a source reads in listings and messages. */
export function describeSource(s: PackageSource): string {
  if (s.type === "path") return s.path
  if (s.type === "npm") return `npm:${s.spec}`
  return `${s.url}${s.ref ? `#${s.ref}` : ""}${s.path ? ` (${s.path})` : ""}`
}
