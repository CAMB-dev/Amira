import path from "node:path"
import { parseArgs } from "node:util"
import {
  amiraHome,
  defaultGitCacheDir,
  describeSource,
  GIT_CACHE_UNUSED_DAYS,
  GitCache,
  gitCacheKey,
  gitUrlsInUse,
  type IndexOptions,
  type InstalledPackage,
  type InstallOptions,
  installPackage,
  type LockEntry,
  listGitCaches,
  listInstalled,
  loadIndex,
  missingPackages,
  PackageError,
  packageScope,
  parseSpec,
  pruneGitCaches,
  readLock,
  removeGitCache,
  removePackage,
  repoLabel,
  restorePackages,
  searchIndex,
  type UpdateResult,
  updatePackages,
} from "@amira/core"
import { UsageError } from "./args.ts"
import { ExtProgress, type Outcome, progressMode, shortReason } from "./ext-progress.ts"
import type { PrintIO } from "./print.ts"

export const EXT_USAGE = `Usage:
  amira ext install <source>...  Install packages (user scope unless --project)
  amira ext install              Install what the lock file pins but is missing
  amira ext list                 List installed packages of both scopes
  amira ext remove <name>...     Remove packages
  amira ext update [name]...     Fetch the newest version and re-pin (all by default)
  amira ext search [query]       Search the extensions index
  amira ext cache [list]         Show the cached git repositories
  amira ext cache prune          Delete the caches no installed package uses (also: ext gc)
  amira ext cache clean          Delete every cached repository

Sources: a directory, a git URL with an optional #ref (https://, ssh://, git@,
file://), an npm package (npm:name[@range], @scope/name, name@range), or a
name from the extensions index.

Options:
  --project     Use <cwd>/.amira/packages instead of ~/.amira/packages
  --refresh     search: download the index even if the cached copy is fresh
  --quiet       install, update, remove: print only the results
  --json        install, update, remove: one JSON object per line

Each scope pins exact commits and versions in its packages.lock. Project
packages replace user packages of the same name. The index comes from
$AMIRA_EXTENSIONS_INDEX, or the CAMB-dev/amira-extensions repository. Git
repositories are cached in ~/.amira/cache/git; a cache no package uses is
deleted after ${GIT_CACHE_UNUSED_DAYS} days.`

export interface ExtCommandOptions {
  home?: string
  cwd?: string
  index?: IndexOptions
  fetch?: typeof fetch
  /** stdout is a terminal: progress is redrawn in place. */
  tty?: boolean
  columns?: () => number | undefined
  rows?: () => number | undefined
  /** For NO_COLOR; default process.env. */
  env?: Record<string, string | undefined>
  /** Stops the command (as Ctrl+C does). */
  signal?: AbortSignal
  /** Ctrl+C cancels the package being worked on and stops; a second one exits. */
  handleSigint?: boolean
  /** The spinner's frame interval (0: redraw on events only). */
  spinnerMs?: number
  /** Where git repositories are cached; default <home>/cache/git. */
  cacheDir?: string
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
  const cacheDir = opts.cacheDir ?? defaultGitCacheDir(home)
  const scope = packageScope(parsed.values.project ? "project" : "user", { home, cwd })
  const index: IndexOptions = { ...opts.index, ...(parsed.values.refresh ? { refresh: true } : {}) }
  const progress = new ExtProgress({
    mode: progressMode(parsed.values, !!opts.tty, opts.env ?? process.env),
    stdout: io.stdout,
    stderr: io.stderr,
    ...(opts.columns ? { columns: opts.columns } : {}),
    ...(opts.rows ? { rows: opts.rows } : {}),
    ...(opts.spinnerMs !== undefined ? { intervalMs: opts.spinnerMs } : {}),
  })
  const abort = new AbortController()
  const signal = opts.signal ? AbortSignal.any([opts.signal, abort.signal]) : abort.signal
  const stopSigint = opts.handleSigint ? onSigint(abort, progress) : () => {}
  const install: InstallOptions = {
    scope,
    cwd,
    index,
    cacheDir,
    gitCache: new GitCache(cacheDir),
    signal,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    log: (line) => progress.note(line.startsWith("warning: ") ? `amira: ${line}` : line),
    onProgress: (p) => progress.update(p),
  }
  /** Full errors of failed packages, printed after the package lines in a terminal. */
  const failures: string[] = []
  const fail = (name: string, message: string, line: string) => {
    progress.finish(name, { kind: "failed", text: shortReason(message), line, data: { error: message } })
    if (progress.mode === "tty") failures.push(line)
  }
  const done = (code: number) => {
    progress.close()
    for (const f of failures) io.stderr(`${f}\n`)
    return code
  }
  try {
    switch (sub) {
      case "install":
      case "add": {
        if (!rest.length) {
          const missing = missingPackages(scope)
          if (!missing.length) {
            io.stdout(`Nothing to install: every package in ${scope.lockFile} is present.\n`)
            return 0
          }
          for (const name of missing) progress.add(name)
          await restorePackages(install, (r) =>
            progress.finish(r.name, {
              kind: "installed",
              text: `${r.entry.version} ${pinText(r.entry)}`,
              line: `Installed ${r.name} ${r.entry.version} ${pinText(r.entry)}`,
              data: { version: r.entry.version, pinned: r.entry.pinned },
            }),
          )
          autoPrune(cacheDir, home, cwd)
          return done(0)
        }
        for (const spec of rest) progress.add(spec, specLabel(spec, cwd))
        for (const spec of rest) {
          signal.throwIfAborted()
          let r: Awaited<ReturnType<typeof installPackage>>
          try {
            r = await installPackage(spec, install)
          } catch (err) {
            if (signal.aborted || !(err instanceof PackageError)) throw err
            fail(spec, err.message, `amira: ${err.message}`)
            return done(1)
          }
          for (const w of r.warnings) progress.note(`amira: warning: ${w}`)
          const was = r.previous ? ` (was ${r.previous.version} ${pinText(r.previous)})` : ""
          progress.finish(spec, {
            kind: "installed",
            text: `${r.name === specLabel(spec, cwd) ? "" : `${r.name} `}${r.entry.version} ${pinText(r.entry)}${was}`,
            line: `Installed ${r.name} ${r.entry.version} ${pinText(r.entry)} into ${scope.kind} scope${was}`,
            data: { package: r.name, version: r.entry.version, pinned: r.entry.pinned, scope: scope.kind },
          })
        }
        autoPrune(cacheDir, home, cwd)
        return done(0)
      }
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
            progress.finish(name, {
              kind: "removed",
              text: `from the ${scope.kind} scope`,
              line: `Removed ${name} from ${scope.kind} scope.`,
              data: { scope: scope.kind },
            })
            continue
          }
          const other = listInstalled({ home, cwd }).find((p) => p.name === name)
          const hint = other
            ? `; it is in the ${other.scope} scope${other.scope === "project" ? " (use --project)" : ""}`
            : ""
          const message = `${name} is not installed in the ${scope.kind} scope${hint}`
          fail(name, message, `amira: ${message}`)
          code = 1
        }
        autoPrune(cacheDir, home, cwd)
        return done(code)
      }
      case "update":
      case "upgrade": {
        const mine = readLock(scope.lockFile).packages
        const otherKind = scope.kind === "user" ? "project" : "user"
        // Only for hints: a broken lock file in the other scope does not stop this update.
        let others: string[] = []
        try {
          others = Object.keys(readLock(packageScope(otherKind, { home, cwd }).lockFile).packages)
        } catch {}
        const unknown = rest.filter((name) => !mine[name])
        for (const name of unknown) {
          const hint = others.includes(name)
            ? `; it is in the ${otherKind} scope${otherKind === "project" ? " (use --project)" : " (leave out --project)"}`
            : ""
          io.stderr(`amira: ${name} is not installed in the ${scope.kind} scope${hint}\n`)
        }
        if (unknown.length) return 1
        const names = rest.length ? rest : Object.keys(mine)
        if (!names.length) io.stdout(`No packages in the ${scope.kind} scope.\n`)
        if (!rest.length && others.length) {
          progress.note(
            `amira: the ${otherKind} scope's packages (${others.join(", ")}) are updated with amira ext update${otherKind === "project" ? " --project" : ""}`,
          )
        }
        for (const name of names) progress.add(name)
        let code = 0
        await updatePackages(install, rest, (r) => {
          if ("error" in r) code = 1
          reportUpdate(r)
        })
        autoPrune(cacheDir, home, cwd)
        return done(code)
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
      case "cache":
        return cacheCommand(rest, io, { cacheDir, home, cwd })
      case "gc":
        noArgs(sub, rest)
        return cacheCommand(["prune"], io, { cacheDir, home, cwd })
      case undefined:
      case "help":
        io.stdout(`${EXT_USAGE}\n`)
        return sub ? 0 : 2
      default:
        throw new UsageError(`unknown ext command "${sub}"\n\n${EXT_USAGE}`)
    }
  } catch (err) {
    if (signal.aborted) {
      const name = progress.active()
      if (name) progress.finish(name, { kind: "cancelled", text: "", line: `amira: ${name}: cancelled` })
      done(130)
      io.stderr("amira: stopped\n")
      return 130
    }
    if (!(err instanceof PackageError)) throw err
    const name = progress.active()
    if (name) fail(name, err.message, `amira: ${err.message}`)
    else io.stderr(`amira: ${err.message}\n`)
    return done(1)
  } finally {
    stopSigint()
    progress.close()
  }

  function reportUpdate(r: UpdateResult) {
    if ("error" in r) {
      fail(
        r.name,
        r.error,
        `amira: ${r.name}: update failed, kept ${r.from.version} ${pinText(r.from)}: ${r.error}`,
      )
      return
    }
    const outcome: Outcome = r.changed
      ? {
          kind: "updated",
          text: `${r.from.version} ${pinText(r.from)} → ${r.to.version} ${pinText(r.to)}`,
          line: `Updated ${r.name}: ${r.from.version} ${pinText(r.from)} -> ${r.to.version} ${pinText(r.to)}`,
          data: { from: r.from.version, to: r.to.version, pinned: r.to.pinned },
        }
      : {
          kind: "up to date",
          text: `${r.to.version} ${pinText(r.to)}`,
          line: `${r.name} is up to date (${r.to.version} ${pinText(r.to)})`,
          data: { version: r.to.version, pinned: r.to.pinned },
        }
    progress.finish(r.name, outcome)
  }
}

/** The first Ctrl+C cancels (the running git or bun is killed); a second one exits at once. */
function onSigint(abort: AbortController, progress: ExtProgress): () => void {
  const handler = () => {
    if (abort.signal.aborted) {
      progress.close()
      process.exit(130)
    }
    abort.abort(new PackageError("cancelled"))
  }
  process.on("SIGINT", handler)
  return () => process.off("SIGINT", handler)
}

/** Caches of repositories no package uses any more go after GIT_CACHE_UNUSED_DAYS. */
function autoPrune(cacheDir: string, home: string, cwd: string) {
  try {
    pruneGitCaches(cacheDir, {
      keepUrls: gitUrlsInUse({ home, cwd }),
      unusedForMs: GIT_CACHE_UNUSED_DAYS * 86_400_000,
    })
  } catch {}
}

function cacheCommand(
  argv: string[],
  io: PrintIO,
  where: { cacheDir: string; home: string; cwd: string },
): number {
  const [what = "list", ...extra] = argv
  if (extra.length) throw new UsageError(`ext cache ${what} takes no arguments\n\n${EXT_USAGE}`)
  const used = gitUrlsInUse(where)
  const usedKeys = new Set(used.map(gitCacheKey))
  const entries = listGitCaches(where.cacheDir)
  switch (what) {
    case "list":
    case "ls": {
      if (!entries.length) {
        io.stdout(`No cached repositories in ${where.cacheDir}.\n`)
        return 0
      }
      let total = 0
      for (const e of entries) {
        total += e.bytes
        const when = e.lastUsed ? e.lastUsed.toISOString().slice(0, 10) : "unknown"
        const mark = usedKeys.has(e.key) ? "" : "  [unused]"
        io.stdout(`${e.url ?? e.key}  ${formatBytes(e.bytes)}  last used ${when}${mark}\n`)
      }
      io.stdout(`${entries.length} cached, ${formatBytes(total)} in ${where.cacheDir}\n`)
      return 0
    }
    case "prune":
    case "clean": {
      const removed =
        what === "clean"
          ? entries.filter((e) => removeGitCache(where.cacheDir, e.key))
          : pruneGitCaches(where.cacheDir, { keepUrls: used })
      const busy = what === "clean" ? entries.length - removed.length : 0
      const bytes = removed.reduce((n, e) => n + e.bytes, 0)
      io.stdout(
        removed.length
          ? `Removed ${removed.length} cached ${removed.length === 1 ? "repository" : "repositories"} (${formatBytes(bytes)}).\n`
          : "Nothing to remove.\n",
      )
      if (busy) io.stderr(`amira: ${busy} in use by another amira process; kept\n`)
      return 0
    }
    default:
      throw new UsageError(`unknown ext cache command "${what}"\n\n${EXT_USAGE}`)
  }
}

/** A spec as a package line shows it: a directory's name, a repository's owner/name. */
function specLabel(spec: string, cwd: string): string {
  try {
    const s = parseSpec(spec, cwd)
    if (s.type === "path") return path.basename(s.path) || spec
    if (s.type === "git") return `${repoLabel(s.url)}${s.ref ? `#${s.ref}` : ""}`
  } catch {}
  return spec
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(1)} MiB`
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
      quiet: { type: "boolean", short: "q" },
      json: { type: "boolean" },
    },
  })
}
