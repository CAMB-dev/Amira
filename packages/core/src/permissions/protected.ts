import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Files the file tools (write, edit, apply_patch) always ask before changing, whatever the
 * mode: Amira's own settings, packages and lock files (any `.amira` directory and Amira's user
 * directory), Git's metadata (`.git`, where hooks and config live, and a `.git` file pointing
 * elsewhere), `.gitmodules`, the directories `core.hooksPath` names and the user's Git config.
 * Shell commands can still change them until commands run in a sandbox.
 */
export interface ProtectedMatch {
  /** The path as the tool would write it. */
  path: string
  /** What is protected there, for the question. */
  what: string
}

export interface ProtectOptions {
  /** Amira's user directory (AMIRA_HOME or ~/.amira). */
  amiraHome?: string
  /** The user's home directory, for the global Git config. */
  homedir?: string
  env?: Record<string, string | undefined>
  platform?: string
}

/**
 * A path as the file tools resolve it (see builtin-tools resolvePath): `~` expanded and, on
 * Windows, the MSYS forms Git Bash prints (`/c/...`, `/tmp/...`), against `cwd`.
 */
export function toolPath(cwd: string, p: string, opts: ProtectOptions = {}): string {
  const platform = opts.platform ?? process.platform
  const home = opts.homedir ?? os.homedir()
  const mod = platform === "win32" ? path.win32 : path.posix
  let expanded = p
  const tilde = p.match(/^~(?=$|[/\\])(.*)$/s)
  if (tilde) expanded = mod.join(home, tilde[1]!)
  else if (platform === "win32") {
    const tmp = p.match(/^\/tmp(?=$|\/)(.*)$/s)
    const drive = p.match(/^\/([a-zA-Z])(?:$|\/)(.*)$/s)
    if (tmp) expanded = mod.join(os.tmpdir(), tmp[1]!)
    else if (drive) expanded = `${drive[1]!.toUpperCase()}:\\${drive[2]!}`
  }
  return mod.isAbsolute(expanded) ? mod.resolve(expanded) : mod.resolve(cwd, expanded)
}

/**
 * The names a path can go by, for comparing: lower case (some file systems ignore case), and
 * on Windows without `\\?\` prefixes, alternate data streams (`config::$DATA`) and the dots
 * and spaces Windows drops from the end of a name (`.git.`).
 */
function comparable(abs: string, platform: string): string {
  if (platform !== "win32") return abs.toLowerCase()
  let p = abs.replaceAll("/", "\\")
  if (/^\\\\[?.]\\unc\\/i.test(p)) p = `\\\\${p.slice(8)}`
  else if (/^\\\\[?.]\\/.test(p)) p = p.slice(4)
  const parts = p.split("\\").map((seg, i) => {
    if (i === 0 && /^[a-z]:$/i.test(seg)) return seg
    const stream = seg.indexOf(":")
    const name = stream >= 0 ? seg.slice(0, stream) : seg
    return name.replace(/[. ]+$/, "") || name
  })
  return path.win32.normalize(parts.join("\\")).toLowerCase()
}

/** The path with its deepest existing ancestor resolved through links (symlinks, junctions, 8.3 names). */
function realName(abs: string, platform: string): string | undefined {
  const mod = platform === "win32" ? path.win32 : path.posix
  let dir = abs
  const rest: string[] = []
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync.native(dir)
      return rest.length ? mod.join(real, ...rest.reverse()) : real
    } catch {
      const parent = mod.dirname(dir)
      if (parent === dir) return undefined
      rest.push(mod.basename(dir))
      dir = parent
    }
  }
  return undefined
}

function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean)
}

function within(child: string, parent: string): boolean {
  if (!parent) return false
  const c = segments(child)
  const p = segments(parent)
  return p.length <= c.length && p.every((s, i) => s === c[i])
}

/** The repository's Git directory and its common directory (they differ in a linked worktree). */
function gitDirs(cwd: string): string[] {
  const out: string[] = []
  let dir = path.resolve(cwd)
  for (let i = 0; i < 128; i++) {
    const dotGit = path.join(dir, ".git")
    if (existsSync(dotGit)) {
      let gitDir = dotGit
      try {
        if (statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))
          if (m) gitDir = path.resolve(dir, m[1]!)
        }
      } catch {}
      out.push(gitDir)
      try {
        const common = readFileSync(path.join(gitDir, "commondir"), "utf8").trim()
        if (common) out.push(path.resolve(gitDir, common))
      } catch {}
      return out
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out
}

/** The worktree's top directory: where `.git` is, walking up from cwd. */
function workTree(cwd: string): string | undefined {
  let dir = path.resolve(cwd)
  for (let i = 0; i < 128; i++) {
    if (existsSync(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** `core.hooksPath` values in a Git config file (simple `[core]` sections; includes are not followed). */
export function hooksPathsIn(text: string): string[] {
  const out: string[] = []
  let core = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)[#;].*$/, "").trim()
    const section = /^\[\s*([^\]\s"]+)[^\]]*\]\s*(.*)$/.exec(line)
    let body = line
    if (section) {
      core = section[1]!.toLowerCase() === "core"
      body = section[2]!
    }
    if (!core || !body) continue
    const kv = /^hookspath\s*=\s*(.*)$/i.exec(body)
    if (kv) out.push(kv[1]!.replace(/^"(.*)"$/, "$1").trim())
  }
  return out.filter(Boolean)
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

/** The user's global Git config files. */
function globalGitConfigs(home: string, env: Record<string, string | undefined>): string[] {
  const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config")
  return [
    path.join(home, ".gitconfig"),
    path.join(xdg, "git", "config"),
    ...(env.GIT_CONFIG_GLOBAL ? [path.resolve(env.GIT_CONFIG_GLOBAL)] : []),
  ]
}

/**
 * Whether a file tool writing `p` (relative to `cwd`) would change a protected file; read
 * fresh on every call, so a hooks directory configured a moment ago counts.
 */
export function protectedPath(cwd: string, p: string, opts: ProtectOptions = {}): ProtectedMatch | undefined {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const home = opts.homedir ?? os.homedir()
  const abs = toolPath(cwd, p, opts)
  const names = [abs, realName(abs, platform)]
    .filter((x): x is string => !!x)
    .map((x) => comparable(x, platform))
  const cmp = (x: string) => comparable(path.resolve(x), platform)

  const gitConfigs = globalGitConfigs(home, env)
  const dirs = gitDirs(cwd)
  const top = workTree(cwd)
  const hookDirs = [...dirs.map((d) => path.join(d, "config")), ...gitConfigs].flatMap((file) =>
    hooksPathsIn(readText(file)).map((h) => {
      const expanded = h.startsWith("~") ? path.join(home, h.slice(1)) : h
      return path.resolve(top ?? cwd, expanded)
    }),
  )

  for (const name of names) {
    const segs = segments(name)
    const base = segs.at(-1) ?? ""
    if (segs.includes(".amira") || (opts.amiraHome && within(name, cmp(opts.amiraHome)))) {
      return { path: abs, what: "Amira's settings, packages and lock files (.amira)" }
    }
    const git = segs.indexOf(".git")
    if (git >= 0) {
      const inside = segs.slice(git + 1)
      const what = inside.includes("hooks")
        ? "Git hooks (.git/hooks)"
        : /^config(\.worktree)?$/.test(inside.at(-1) ?? "")
          ? "Git config (.git/config)"
          : "Git metadata (.git), where hooks and config live"
      return { path: abs, what }
    }
    if (base === ".gitmodules") return { path: abs, what: "Git submodule config (.gitmodules)" }
    for (const d of dirs) {
      if (within(name, cmp(d))) return { path: abs, what: "Git metadata, where hooks and config live" }
    }
    for (const h of hookDirs) {
      if (within(name, cmp(h))) return { path: abs, what: "Git hooks (core.hooksPath)" }
    }
    for (const g of gitConfigs) {
      if (name === cmp(g)) return { path: abs, what: "your Git config" }
    }
  }
  return undefined
}

/**
 * The paths a file tool call would write: `path` for write and edit, every file an
 * apply_patch patch adds, deletes, updates or moves to. Generous on purpose: a header line
 * anywhere counts, whether or not the patch would parse.
 */
export function writtenPaths(toolName: string, args: Record<string, unknown>): string[] {
  if (toolName === "write" || toolName === "edit") return typeof args.path === "string" ? [args.path] : []
  if (toolName !== "apply_patch" || typeof args.patch !== "string") return []
  const out: string[] = []
  for (const raw of args.patch.split(/\r?\n/)) {
    const line = raw.trim()
    const header = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/.exec(line)
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    const found = header?.[1] ?? move?.[1]
    if (found) out.push(found)
  }
  return out
}
