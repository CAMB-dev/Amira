import { existsSync } from "node:fs"
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
}

/** The packages to load at startup: a project package replaces a user package of the same name. */
export function activePackages(where: Where): ActivePackages {
  const out: ActivePackages = { packages: [], problems: [] }
  for (const p of listInstalled(where)) {
    if (p.shadowed) continue
    if (p.manifest) out.packages.push({ ...p, manifest: p.manifest })
    else out.problems.push({ name: p.name, scope: p.scope, error: p.error ?? "unusable" })
  }
  return out
}

/** The module behind `amira <name>`, from the active packages. */
export function findPackageCommand(
  name: string,
  where: Where,
): { file: string; pkg: InstalledPackage & { manifest: PackageManifest } } | undefined {
  let found: ReturnType<typeof findPackageCommand>
  // Later packages win, like later extensions: project over user.
  for (const pkg of activePackages(where).packages) {
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
