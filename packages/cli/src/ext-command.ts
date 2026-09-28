import { parseArgs } from "node:util"
import {
  amiraHome,
  describeSource,
  type IndexOptions,
  type InstalledPackage,
  type InstallOptions,
  installPackage,
  type LockEntry,
  listInstalled,
  loadIndex,
  PackageError,
  packageScope,
  removePackage,
  restorePackages,
  searchIndex,
  updatePackages,
} from "@amira/core"
import { UsageError } from "./args.ts"
import type { PrintIO } from "./print.ts"

export const EXT_USAGE = `Usage:
  amira ext install <source>...  Install packages (user scope unless --project)
  amira ext install              Install what the lock file pins but is missing
  amira ext list                 List installed packages of both scopes
  amira ext remove <name>...     Remove packages
  amira ext update [name]...     Fetch the newest version and re-pin (all by default)
  amira ext search [query]       Search the extensions index

Sources: a directory, a git URL with an optional #ref (https://, ssh://, git@,
file://), an npm package (npm:name[@range], @scope/name, name@range), or a
name from the extensions index.

Options:
  --project     Use <cwd>/.amira/packages instead of ~/.amira/packages
  --refresh     search: download the index even if the cached copy is fresh

Each scope pins exact commits and versions in its packages.lock. Project
packages replace user packages of the same name. The index comes from
$AMIRA_EXTENSIONS_INDEX, or the CAMB-dev/amira-extensions repository.`

export interface ExtCommandOptions {
  home?: string
  cwd?: string
  index?: IndexOptions
  fetch?: typeof fetch
}

/** `amira ext ...`: installing and managing extension packages (D24, D49, D60). */
export async function runExtCommand(
  argv: string[],
  io: PrintIO,
  opts: ExtCommandOptions = {},
): Promise<number> {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(argv)
  } catch (err) {
    throw new UsageError(`${err instanceof Error ? err.message : String(err)}\n\n${EXT_USAGE}`)
  }
  const [sub, ...rest] = parsed.positionals
  const home = opts.home ?? amiraHome()
  const cwd = opts.cwd ?? process.cwd()
  const scope = packageScope(parsed.values.project ? "project" : "user", { home, cwd })
  const index: IndexOptions = { ...opts.index, ...(parsed.values.refresh ? { refresh: true } : {}) }
  const install: InstallOptions = {
    scope,
    cwd,
    index,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    log: (line) => io.stderr(`${line}\n`),
  }
  try {
    switch (sub) {
      case "install":
      case "add":
        if (!rest.length) {
          const restored = await restorePackages(install)
          if (!restored.length)
            io.stdout(`Nothing to install: every package in ${scope.lockFile} is present.\n`)
          for (const r of restored) io.stdout(`Installed ${r.name} ${r.entry.version} ${pinText(r.entry)}\n`)
          return 0
        }
        for (const spec of rest) {
          const r = await installPackage(spec, install)
          for (const w of r.warnings) io.stderr(`amira: warning: ${w}\n`)
          const was = r.previous ? ` (was ${r.previous.version} ${pinText(r.previous)})` : ""
          io.stdout(
            `Installed ${r.name} ${r.entry.version} ${pinText(r.entry)} into ${scope.kind} scope${was}\n`,
          )
        }
        return 0
      case "list":
      case "ls":
        noArgs(sub, rest)
        io.stdout(formatList(listInstalled({ home, cwd }), { home, cwd }))
        return 0
      case "remove":
      case "rm":
      case "uninstall": {
        if (!rest.length) throw new UsageError(`ext ${sub} needs a package name\n\n${EXT_USAGE}`)
        let code = 0
        for (const name of rest) {
          if (removePackage(name, scope)) {
            io.stdout(`Removed ${name} from ${scope.kind} scope.\n`)
            continue
          }
          const other = listInstalled({ home, cwd }).find((p) => p.name === name)
          const hint = other
            ? `; it is in the ${other.scope} scope${other.scope === "project" ? " (use --project)" : ""}`
            : ""
          io.stderr(`amira: ${name} is not installed in the ${scope.kind} scope${hint}\n`)
          code = 1
        }
        return code
      }
      case "update":
      case "upgrade": {
        const results = await updatePackages(install, rest)
        if (!results.length) io.stdout(`No packages in the ${scope.kind} scope.\n`)
        for (const r of results) {
          io.stdout(
            r.changed
              ? `Updated ${r.name}: ${r.from.version} ${pinText(r.from)} -> ${r.to.version} ${pinText(r.to)}\n`
              : `${r.name} is up to date (${r.to.version} ${pinText(r.to)})\n`,
          )
        }
        return 0
      }
      case "search": {
        const loaded = await loadIndex(index)
        for (const w of loaded.warnings) io.stderr(`amira: warning: ${w}\n`)
        const installed = listInstalled({ home, cwd })
        const hits = searchIndex(loaded.index, rest.join(" "))
        if (!hits.length) io.stdout(`No extensions match in ${loaded.url}.\n`)
        for (const e of hits) {
          const where = installed.filter((p) => p.name === e.name).map((p) => p.scope)
          const mark = where.length ? `  [installed: ${where.join(", ")}]` : ""
          io.stdout(`${e.name} ${e.version}${mark}\n`)
          if (e.description) io.stdout(`  ${e.description}\n`)
          if (e.tags.length) io.stdout(`  tags: ${e.tags.join(", ")}\n`)
        }
        return 0
      }
      case undefined:
      case "help":
        io.stdout(`${EXT_USAGE}\n`)
        return sub ? 0 : 2
      default:
        throw new UsageError(`unknown ext command "${sub}"\n\n${EXT_USAGE}`)
    }
  } catch (err) {
    if (!(err instanceof PackageError)) throw err
    io.stderr(`amira: ${err.message}\n`)
    return 1
  }
}

function formatList(pkgs: InstalledPackage[], where: { home: string; cwd: string }): string {
  let out = ""
  for (const kind of ["user", "project"] as const) {
    const scope = packageScope(kind, where)
    const mine = pkgs.filter((p) => p.scope === kind)
    out += `${kind} (${scope.dir}):\n`
    if (!mine.length) out += "  (none)\n"
    for (const p of mine) {
      const state = p.error ? `  [${p.error}]` : p.shadowed ? "  [replaced by the project package]" : ""
      out += `  ${p.name} ${p.entry.version} ${pinText(p.entry)}${state}\n`
      out += `    from ${describeSource(p.entry.source)}${p.entry.index ? " via the extensions index" : ""}\n`
    }
  }
  return out
}

function pinText(e: LockEntry): string {
  if (e.pinned.commit) return `@ ${e.pinned.commit.slice(0, 12)}`
  if (e.pinned.version) return `@ npm ${e.pinned.version}`
  return "(local copy)"
}

function noArgs(sub: string, rest: string[]) {
  if (rest.length) throw new UsageError(`ext ${sub} takes no arguments\n\n${EXT_USAGE}`)
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "boolean" },
      refresh: { type: "boolean" },
    },
  })
}
