import path from "node:path"
import type { Settings } from "@amira/api"
import { amiraHome, updateSettingsFile } from "@amira/core"

/**
 * Whether the user said a project's own packages may load: true or false once asked (for the
 * directory or one it is inside), undefined before. Read from merged settings, which only take
 * these lists from the user file.
 */
export function projectTrust(cwd: string, settings: Settings): boolean | undefined {
  const trusted = settings.packages?.trustedProjects
  const untrusted = settings.packages?.untrustedProjects
  // The closest directory decides: a trusted parent with an untrusted child is untrusted there.
  const depth = (list: string[] | undefined) =>
    Math.max(-1, ...(list ?? []).filter((dir) => within(cwd, dir)).map((dir) => norm(dir).length))
  const yes = depth(trusted)
  const no = depth(untrusted)
  if (yes < 0 && no < 0) return undefined
  return yes > no
}

/** Remembers in the user settings whether this project's own packages may load. */
export function rememberProjectTrust(cwd: string, trusted: boolean, home = amiraHome()): void {
  const dir = path.resolve(cwd)
  updatePackageSettings(home, (pkgs) => {
    const drop = (list: unknown) => stringList(list).filter((d) => norm(d) !== norm(dir))
    const keep = trusted ? "trustedProjects" : "untrustedProjects"
    const other = trusted ? "untrustedProjects" : "trustedProjects"
    const out: Record<string, unknown> = { ...pkgs, [keep]: [...drop(pkgs[keep]), dir] }
    const rest = drop(pkgs[other])
    if (rest.length) out[other] = rest
    else delete out[other]
    return out
  })
}

/**
 * Adds a package to, or takes it off, `packages.disabled` in the user settings. Returns whether
 * that changed anything.
 */
export function setPackageDisabled(name: string, disabled: boolean, home = amiraHome()): boolean {
  return updatePackageSettings(home, (pkgs) => {
    const list = stringList(pkgs.disabled).filter((n) => n !== name)
    if (disabled) list.push(name)
    const out: Record<string, unknown> = { ...pkgs, disabled: list }
    if (!list.length) delete out.disabled
    return out
  })
}

/** The user settings file. */
export function userSettingsFile(home = amiraHome()): string {
  return path.join(home, "settings.json")
}

function updatePackageSettings(
  home: string,
  change: (pkgs: Record<string, unknown>) => Record<string, unknown>,
): boolean {
  return updateSettingsFile(userSettingsFile(home), (raw) => {
    const pkgs = change(isPlainObject(raw.packages) ? raw.packages : {})
    const out: Record<string, unknown> = { ...raw, packages: pkgs }
    if (!Object.keys(pkgs).length) delete out.packages
    return out
  })
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

function norm(p: string): string {
  const r = path.resolve(p)
  return process.platform === "win32" ? r.toLowerCase() : r
}

/** Whether `dir` is `root` or inside it. */
function within(dir: string, root: string): boolean {
  if (!root) return false
  const d = norm(dir)
  const r = norm(root)
  return d === r || d.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}
