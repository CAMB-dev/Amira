import { existsSync } from "node:fs"
import path from "node:path"
import {
  type LockEntry,
  type PackageScope,
  packageDir,
  packageScope,
  readLock,
  type ScopeKind,
} from "./lock.ts"
import { engineMismatch, type PackageManifest, readManifest } from "./manifest.ts"

export interface InstalledPackage {
  name: string
  scope: ScopeKind
  dir: string
  entry: LockEntry
  /** Unset when the package cannot be used; `error` says why. */
  manifest?: PackageManifest
  error?: string
  /** A user package hidden by a project package of the same name. */
  shadowed?: boolean
}

export interface Where {
  /** The user directory; default $AMIRA_HOME or ~/.amira. */
  home?: string
  cwd: string
}

/**
 * Whether the project scope is the user scope: amira run from the home directory, where the
 * project's packages (<cwd>/.amira/packages) are the user's own and need no trust.
 */
export function projectScopeIsUser(where: Where): boolean {
  const norm = (dir: string) => {
    const r = path.resolve(dir)
    return process.platform === "win32" ? r.toLowerCase() : r
  }
  return norm(packageScope("project", where).dir) === norm(packageScope("user", where).dir)
}

/** Every package the lock files of both scopes record, user scope first. */
export function listInstalled(where: Where): InstalledPackage[] {
  const project = scopePackages(packageScope("project", where))
  const projectNames = new Set(project.map((p) => p.name))
  const user = scopePackages(packageScope("user", where)).map((p) =>
    projectNames.has(p.name) ? { ...p, shadowed: true } : p,
  )
  return [...user, ...project]
}

export interface ActivePackages {
  /** What to load, in order: user packages, then project packages (D60). */
  packages: (InstalledPackage & { manifest: PackageManifest })[]
  /** Packages that are recorded but cannot be loaded. */
  problems: { name: string; scope: ScopeKind; error: string }[]
  /**
   * Packages left out on purpose: `disabled` in settings (packages.disabled), or `untrusted`
   * (a project's own packages, while the project is not trusted).
   */
  skipped: { name: string; scope: ScopeKind; why: "disabled" | "untrusted" }[]
}

export interface ActiveOptions {
  /** Names of packages not to load (settings packages.disabled), of either scope. */
  disabled?: readonly string[]
  /**
   * Whether the project's own packages (<cwd>/.amira/packages) may load. Default true; false
   * leaves them out, and user packages they would replace load instead.
   */
  project?: boolean
}

/**
 * The packages to load at startup: a project package replaces a user package of the same name.
 * Disabled packages and, unless `project` allows them, the project's packages are skipped.
 */
export function activePackages(where: Where, opts: ActiveOptions = {}): ActivePackages {
  const out: ActivePackages = { packages: [], problems: [], skipped: [] }
  const project = opts.project ?? true
  const disabled = new Set(opts.disabled ?? [])
  for (const p of listInstalled(where)) {
    if (p.scope === "project" && !project) {
      out.skipped.push({ name: p.name, scope: p.scope, why: "untrusted" })
      continue
    }
    if (p.shadowed && project) continue
    if (disabled.has(p.name)) {
      out.skipped.push({ name: p.name, scope: p.scope, why: "disabled" })
      continue
    }
    if (p.manifest) out.packages.push({ ...p, manifest: p.manifest })
    else out.problems.push({ name: p.name, scope: p.scope, error: p.error ?? "unusable" })
  }
  return out
}

/** The names of the packages the project's own lock file records (<cwd>/.amira/packages). */
export function projectPackageNames(where: Where): string[] {
  return listInstalled(where)
    .filter((p) => p.scope === "project")
    .map((p) => p.name)
}

/** The module behind `amira <name>`, from the active packages. */
export function findPackageCommand(
  name: string,
  where: Where,
  opts: ActiveOptions = {},
): { file: string; pkg: InstalledPackage & { manifest: PackageManifest } } | undefined {
  let found: ReturnType<typeof findPackageCommand>
  // Later packages win, like later extensions: project over user.
  for (const pkg of activePackages(where, opts).packages) {
    const file = pkg.manifest.commands[name]
    if (file) found = { file, pkg }
  }
  return found
}

function scopePackages(scope: PackageScope): InstalledPackage[] {
  let entries: [string, LockEntry][]
  try {
    entries = Object.entries(readLock(scope.lockFile).packages)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return [{ name: scope.lockFile, scope: scope.kind, dir: scope.dir, entry: brokenEntry, error }]
  }
  return entries.map(([name, entry]) => {
    const dir = packageDir(scope, name)
    const base = { name, scope: scope.kind, dir, entry }
    if (!existsSync(dir)) {
      const flag = scope.kind === "project" ? " --project" : ""
      return {
        ...base,
        error: `not installed here; run amira ext install${flag} to fetch the pinned version`,
      }
    }
    try {
      const manifest = readManifest(dir)
      const mismatch = engineMismatch(manifest)
      return mismatch ? { ...base, error: mismatch } : { ...base, manifest }
    } catch (err) {
      return { ...base, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

const brokenEntry: LockEntry = {
  version: "",
  source: { type: "path", path: "" },
  pinned: {},
  installedAt: "",
}
