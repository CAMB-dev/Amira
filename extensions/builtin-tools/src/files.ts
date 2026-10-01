import type { Dirent } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

export const SKIP_DIRS = new Set([".git", "node_modules"])

/** A NUL byte in the first 8 KB marks a file as binary. */
export function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

export async function statOrNull(path: string) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

export interface WalkEntry {
  abs: string
  /** Forward-slash path relative to the walk root. */
  rel: string
}

/**
 * A pattern from an ignore file. Paths are matched relative to the file's directory: `base`
 * is that directory relative to the walk root (rules found during the walk), `up` the walk
 * root relative to it (rules from the repository above the walk root).
 */
interface IgnoreRule {
  base: string
  up: string
  negated: boolean
  directoryOnly: boolean
  /** A pattern with a slash matches the whole relative path; one without, the name at any level. */
  wholePath: boolean
  regex: RegExp
}

interface Repository {
  root: string
  gitDir: string
  commonDir: string
}

/**
 * Yields files under `root` in sorted order. Like git, it leaves out what the repository's
 * ignore files (.gitignore files, info/exclude, core.excludesFile) exclude, never descends
 * into an excluded directory, and skips .git and node_modules. A directory holding its own
 * `.git` (another repository or a linked worktree) is skipped, except a submodule of the
 * walked repository. Symlinked directories are not followed.
 */
export async function* walkFiles(root: string, signal?: AbortSignal): AsyncGenerator<WalkEntry> {
  const walkRoot = resolve(root)
  const repo = await repository(walkRoot)
  const stack: [string, string, IgnoreRule[]][] = [[walkRoot, "", await outerRules(walkRoot, repo)]]
  while (stack.length > 0) {
    if (signal?.aborted) return
    const [dir, prefix, inherited] = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    let rules = inherited
    if (prefix) {
      const dotGit = entries.find((e) => e.name === ".git")
      if (dotGit && !(dotGit.isFile() && (await isSubmodule(join(dir, ".git"), repo)))) continue
      if (entries.some((e) => e.name === ".gitignore" && e.isFile())) {
        rules = [...rules, ...(await readIgnoreFile(join(dir, ".gitignore"), prefix, ""))]
      }
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const subdirs: [string, string, IgnoreRule[]][] = []
    for (const e of entries) {
      if (e.name === ".git") continue
      const abs = join(dir, e.name)
      const rel = prefix + e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !ignored(rel, e.name, true, rules))
          subdirs.push([abs, `${rel}/`, rules])
      } else if (e.isFile() || (e.isSymbolicLink() && (await statOrNull(abs))?.isFile())) {
        if (!ignored(rel, e.name, false, rules)) yield { abs, rel }
      }
    }
    stack.push(...subdirs.reverse())
  }
}

/** Rules that apply at the walk root: global excludes, info/exclude and .gitignore files from the repository root down. */
async function outerRules(walkRoot: string, repo: Repository | undefined): Promise<IgnoreRule[]> {
  const top = repo?.root ?? walkRoot
  const up = relative(top, walkRoot).replaceAll("\\", "/")
  const upPrefix = up ? `${up}/` : ""
  const rules: IgnoreRule[] = []
  const global = await globalExcludeFile()
  if (global) rules.push(...(await readIgnoreFile(global, "", upPrefix)))
  if (repo) rules.push(...(await readIgnoreFile(join(repo.commonDir, "info", "exclude"), "", upPrefix)))
  const parts = up ? up.split("/") : []
  for (let i = 0; i <= parts.length; i++) {
    const below = parts.slice(i).join("/")
    rules.push(
      ...(await readIgnoreFile(join(top, ...parts.slice(0, i), ".gitignore"), "", below ? `${below}/` : "")),
    )
  }
  return rules
}

/** A `.git` file pointing into the walked repository's modules directory marks a submodule (in a linked worktree, under its own git dir). */
async function isSubmodule(dotGit: string, repo: Repository | undefined): Promise<boolean> {
  if (!repo) return false
  const gitDir = gitDirOf(dotGit, await readText(dotGit))
  if (!gitDir) return false
  return [repo.gitDir, repo.commonDir].some((dir) => {
    const rel = relative(join(dir, "modules"), gitDir)
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel)
  })
}

function gitDirOf(dotGit: string, text: string | undefined): string | undefined {
  const match = /^gitdir:\s*(.+?)\s*$/im.exec(text ?? "")
  return match ? resolve(dirname(dotGit), match[1]!) : undefined
}

async function repository(start: string): Promise<Repository | undefined> {
  for (let dir = start; ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git")
    const st = await statOrNull(dotGit)
    if (st) {
      const gitDir = st.isFile() ? gitDirOf(dotGit, await readText(dotGit)) : dotGit
      if (!gitDir) return undefined
      const commonText = await readText(join(gitDir, "commondir"))
      return { root: dir, gitDir, commonDir: commonText ? resolve(gitDir, commonText.trim()) : gitDir }
    }
    if (dirname(dir) === dir) return undefined
  }
}

async function readIgnoreFile(file: string, base: string, up: string): Promise<IgnoreRule[]> {
  const text = await readText(file)
  if (text === undefined) return []
  const rules: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    let pattern = raw.trimEnd()
    if (!pattern || pattern.startsWith("#")) continue
    let negated = false
    if (pattern.startsWith("!")) {
      negated = true
      pattern = pattern.slice(1)
    } else if (pattern.startsWith("#") || pattern.startsWith("!")) pattern = pattern.slice(1)
    const directoryOnly = pattern.endsWith("/")
    if (directoryOnly) pattern = pattern.slice(0, -1)
    const wholePath = pattern.includes("/")
    if (pattern.startsWith("/")) pattern = pattern.slice(1)
    if (!pattern) continue
    rules.push({ base, up, negated, directoryOnly, wholePath, regex: globRegex(pattern) })
  }
  return rules
}

/** The last matching rule decides, as in git. `rel` is relative to the walk root. */
function ignored(rel: string, name: string, directory: boolean, rules: IgnoreRule[]): boolean {
  let out = false
  for (const rule of rules) {
    if (rule.directoryOnly && !directory) continue
    if (rule.negated !== out) continue
    const match = rule.wholePath
      ? rule.regex.test(rule.up + rel.slice(rule.base.length))
      : rule.regex.test(name)
    if (match) out = !rule.negated
  }
  return out
}

function globRegex(pattern: string): RegExp {
  let out = "^"
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === "*" && pattern[i + 1] === "*") {
      i++
      if (pattern[i + 1] === "/") {
        i++
        out += "(?:.*/)?"
      } else out += ".*"
    } else if (c === "*") out += "[^/]*"
    else if (c === "?") out += "[^/]"
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1)
      if (end === -1) out += "\\["
      else {
        const chars = pattern.slice(i + 1, end)
        out += `[${chars.startsWith("!") ? "^" : ""}${chars.startsWith("!") ? chars.slice(1) : chars}]`
        i = end
      }
    } else out += /[\\.+^${}()|]/.test(c) ? `\\${c}` : c
  }
  return new RegExp(`${out}$`)
}

async function globalExcludeFile(): Promise<string | undefined> {
  const configured = process.env.GIT_CONFIG_GLOBAL
  const files = [
    ...(configured ? [configured] : []),
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "git", "config") : "",
    join(homedir(), ".gitconfig"),
    join(homedir(), ".config", "git", "config"),
  ].filter(Boolean)
  for (const file of [...new Set(files)]) {
    const text = await readText(file)
    const value = gitConfigValue(text, "excludesfile")
    if (!value) continue
    const expanded = value.replace(/^~(?=$|[\\/])/, homedir())
    return isAbsolute(expanded) ? expanded : resolve(homedir(), expanded)
  }
  const defaultFile = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "git", "ignore")
  return (await readText(defaultFile)) === undefined ? undefined : defaultFile
}

function gitConfigValue(text: string | undefined, wanted: string): string | undefined {
  if (!text) return undefined
  let section = ""
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) {
      section = header[1]!.toLowerCase()
      continue
    }
    const entry = /^([^=\s]+)\s*=\s*(.*)$/.exec(line)
    if (section === "core" && entry?.[1]?.toLowerCase() === wanted) {
      const value = entry[2]!.trim()
      return value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
        ? value.slice(1, -1)
        : value
    }
  }
  return undefined
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8")
  } catch {
    return undefined
  }
}
