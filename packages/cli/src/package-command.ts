import { existsSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { API_VERSION, type PackageCommandContext } from "@amira/api"
import { amiraHome, findPackageCommand, installVirtualApi } from "@amira/core"
import { runCommand } from "@amira/proc"
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
  const found = findPackageCommand(name, where)
  if (!found) return undefined
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
    runCommand: (a, o) => runCommand(a, o),
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
