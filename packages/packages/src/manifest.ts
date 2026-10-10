import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { API_VERSION } from "@amira/api"

/** A package that cannot be installed or loaded; the message says which and why. */
export class PackageError extends Error {
  override name = "PackageError"
}

/**
 * What a package contributes (D24), from `amira-package.json` or the `amira` field of its
 * package.json. Paths are absolute.
 */
export interface PackageManifest {
  name: string
  version: string
  /** Semver range of the extension API (`@amira/api`) the package works with. */
  engine?: string
  description?: string
  /** Extension modules, loaded after the built-ins. */
  extensions: string[]
  /** Skill directories, searched like settings `skills.dirs`. */
  skills: string[]
  /** Theme JSON files, loaded after user and project themes. */
  themes: string[]
  /** Top-level `amira <name>` commands: name to module default-exporting a PackageCommand. */
  commands: Record<string, string>
  /** Whether package.json lists dependencies that must be installed next to it. */
  hasDependencies: boolean
}

const NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/
const COMMAND = /^[a-z][\w-]*$/

export function isValidPackageName(name: string): boolean {
  return NAME.test(name) && !name.split("/").some((p) => p === "." || p === "..")
}

/**
 * Reads a package directory. Without an `extensions` list, `index.ts` or `src/index.ts` is the
 * one extension, so a single-file package needs no manifest beyond a name.
 */
export function readManifest(dir: string): PackageManifest {
  const own = readJson(path.join(dir, "amira-package.json"))
  const pkg = readJson(path.join(dir, "package.json"))
  const amira = own ?? (isObject(pkg?.amira) ? pkg.amira : undefined)
  if (!amira && !pkg) throw new PackageError(`${dir}: no amira-package.json or package.json`)
  const field = (key: string) => amira?.[key] ?? pkg?.[key]
  const name = field("name")
  if (typeof name !== "string" || !isValidPackageName(name)) {
    throw new PackageError(
      `${dir}: the package needs a valid "name" (lowercase, npm style), got ${show(name)}`,
    )
  }
  const version = field("version") ?? "0.0.0"
  if (typeof version !== "string" || !Bun.semver.satisfies(version, "*")) {
    throw new PackageError(`${name}: "version" must be a semver version, got ${show(version)}`)
  }
  const engines = field("engines")
  const engine = isObject(engines) && typeof engines.amira === "string" ? engines.amira : undefined
  const within = (key: string, p: unknown) => {
    if (typeof p !== "string") throw new PackageError(`${name}: "${key}" entries must be paths`)
    const abs = path.resolve(dir, p)
    const rel = path.relative(dir, abs)
    if (rel.startsWith("..") || path.isAbsolute(rel))
      throw new PackageError(`${name}: "${p}" is outside the package`)
    return abs
  }
  const paths = (key: string): string[] | undefined => {
    const v = amira?.[key]
    if (v === undefined) return undefined
    if (!Array.isArray(v)) throw new PackageError(`${name}: "${key}" must be a list of paths`)
    return v.map((p) => within(key, p))
  }
  const commands: Record<string, string> = {}
  const cmds = amira?.commands
  if (cmds !== undefined) {
    if (!isObject(cmds)) throw new PackageError(`${name}: "commands" must map names to modules`)
    for (const [cmd, file] of Object.entries(cmds)) {
      if (!COMMAND.test(cmd)) throw new PackageError(`${name}: command name "${cmd}" is not allowed`)
      commands[cmd] = within("commands", file)
    }
  }
  const themes = paths("themes")
  const description = field("description")
  const deps = pkg?.dependencies
  return {
    name,
    version,
    ...(engine ? { engine } : {}),
    ...(typeof description === "string" ? { description } : {}),
    extensions: paths("extensions") ?? defaultEntry(dir, !!cmds || themes !== undefined),
    skills: paths("skills") ?? [],
    themes: themes ?? [],
    commands,
    hasDependencies: isObject(deps) && Object.keys(deps).some((d) => !d.startsWith("@amira/")),
  }
}

/** Whether this Amira's extension API satisfies the package's engine range. */
export function engineMismatch(m: PackageManifest, apiVersion = API_VERSION): string | undefined {
  if (!m.engine || Bun.semver.satisfies(apiVersion, m.engine)) return undefined
  return `${m.name} ${m.version} needs Amira extension API ${m.engine}; this Amira has ${apiVersion}`
}

/** Packages contributing commands or themes need no implicit extension. */
function defaultEntry(dir: string, optional: boolean): string[] {
  for (const f of ["index.ts", "src/index.ts"]) {
    const abs = path.join(dir, f)
    if (existsSync(abs)) return [abs]
  }
  if (optional) return []
  throw new PackageError(`${dir}: no "extensions" list, and neither index.ts nor src/index.ts exists`)
}

function readJson(file: string): Record<string, any> | undefined {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  try {
    const v = JSON.parse(text)
    if (isObject(v)) return v
  } catch {}
  throw new PackageError(`${file}: not a JSON object`)
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function show(v: unknown): string {
  return JSON.stringify(v) ?? String(v)
}
