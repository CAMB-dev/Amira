import { existsSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { API_VERSION, type PackageCommandContext, type Settings } from "@amira/api"
import {
  amiraHome,
  findPackageCommand,
  installVirtualApi,
  loadSettings,
  projectScopeIsUser,
  projectTrust,
} from "@amira/core"
import { DEFAULT_MAX_OUTPUT_CHARS, runCommand } from "@amira/proc"
import type { PrintIO } from "./print.ts"

/** Commands built into the CLI; a package cannot take these names. */
const RESERVED = new Set(["provider", "ext", "help"])

/**
 * Runs `amira <name> ...` when an installed package provides that command (D48: e.g.
 * `amira mcp serve`). Undefined when none does, so the arguments are read as usual.
 */
export async function runPackageCommand(
  argv: string[],
  io: PrintIO,
  where: { cwd: string; home?: string } = { cwd: process.cwd() },
): Promise<number | undefined> {
  const [name, ...rest] = argv
  if (!name || name.startsWith("-") || RESERVED.has(name)) return undefined
  // Disabled packages offer no commands, nor do a project's own before it is trusted.
  let settings: Settings = {}
  try {
    settings = loadSettings(where).settings
  } catch {}
  const project = projectScopeIsUser(where) || projectTrust(where.cwd, settings) === true
  const found = findPackageCommand(name, where, { disabled: settings.packages?.disabled ?? [], project })
  if (!found) {
    const untrusted = project ? undefined : findPackageCommand(name, where)
    if (untrusted?.pkg.scope !== "project") return undefined
    io.stderr(
      `amira: "${name}" comes from this project's package ${untrusted.pkg.name}, which is not trusted; run amira ext trust to allow this project's packages\n`,
    )
    return 1
  }
  installVirtualApi()
  const mod = (await import(pathToFileURL(found.file).href)) as { default?: unknown }
  if (typeof mod.default !== "function") {
    io.stderr(
      `amira: ${found.file} (command "${name}" of ${found.pkg.name}) must default-export a function\n`,
    )
    return 1
  }
  const ctx: PackageCommandContext = {
    apiVersion: API_VERSION,
    argv: rest,
    cwd: where.cwd,
    home: where.home ?? amiraHome(),
    amiraArgv: amiraArgv(),
    runCommand: (a, o) =>
      runCommand(a, { ...o, maxOutputChars: o.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS }),
    stdin: Bun.stdin.stream(),
    stdout: io.stdout,
    stderr: io.stderr,
  }
  const code = await (mod.default as (c: PackageCommandContext) => unknown)(ctx)
  return typeof code === "number" ? code : 0
}

/**
 * How to start this Amira again: the compiled executable alone, or the runtime plus the
 * entry script when run from source.
 */
export function amiraArgv(argv = process.argv, execPath = process.execPath): string[] {
  const script = argv[1]
  return script && /\.[cm]?[jt]s$/.test(script) && existsSync(script) ? [execPath, script] : [execPath]
}
