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

interface IgnoreRule {
  sourceDir: string
  pattern: string
  negated: boolean
  directoryOnly: boolean
  anchored: boolean
  hasSlash: boolean
  regex: RegExp
}

interface IgnoreState {
  rules: IgnoreRule[]
}

interface Repository {
  root: string
  gitDir: string
  commonDir: string
}

/**
 * Yields files under `root` in sorted order, honoring Git's ignore files and skipping .git,
 * node_modules and nested repositories. Symlinked directories are not followed.
 */
export async function* walkFiles(root: string, signal?: AbortSignal): AsyncGenerator<WalkEntry> {
  const walkRoot = resolve(root)
  const state = await ignoreState(walkRoot)
  const stack: [string, string, IgnoreRule[]][] = [[walkRoot, "", state.rules]]
  while (stack.length > 0) {
    if (signal?.aborted) return
    const [dir, prefix, rules] = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const subdirs: [string, string, IgnoreRule[]][] = []
    for (const e of entries) {
      if (e.name === ".git") continue
      const abs = join(dir, e.name)
      const rel = prefix + e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (await hasGitEntry(abs)) || ignored(abs, true, rules)) continue
        subdirs.push([abs, `${rel}/`, await addIgnoreFile(rules, abs)])
      } else if (e.isFile()) {
        if (!ignored(abs, false, rules)) yield { abs, rel }
      } else if (e.isSymbolicLink() && (await statOrNull(abs))?.isFile()) {
        if (!ignored(abs, false, rules)) yield { abs, rel }
      }
    }
    stack.push(...subdirs.reverse())
  }
}

async function ignoreState(root: string): Promise<IgnoreState> {
  const repo = await repository(root)
  const rules: IgnoreRule[] = []
  const global = await globalExcludeFile()
  if (global) rules.push(...(await readIgnoreFile(global, repo?.root ?? root)))
  if (repo) {
    const exclude = join(repo.commonDir, "info", "exclude")
    rules.push(...(await readIgnoreFile(exclude, repo.root)))
    const dirs = [repo.root]
    const fromRepo = relative(repo.root, resolve(root))
    if (fromRepo && !fromRepo.startsWith("..") && !isAbsolute(fromRepo)) {
      let current = repo.root
      for (const part of fromRepo.split(/[\\/]+/)) {
        current = join(current, part)
        dirs.push(current)
      }
    }
    for (const dir of dirs) rules.push(...(await readIgnoreFile(join(dir, ".gitignore"), dir)))
  } else {
    rules.push(...(await readIgnoreFile(join(root, ".gitignore"), root)))
  }
  return { rules }
}

async function addIgnoreFile(rules: IgnoreRule[], dir: string): Promise<IgnoreRule[]> {
  return [...rules, ...(await readIgnoreFile(join(dir, ".gitignore"), dir))]
}

async function repository(start: string): Promise<Repository | undefined> {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git")
    const st = await statOrNull(dotGit)
    if (st) {
      let gitDir = dotGit
      if (st.isFile()) {
        const text = await readText(dotGit)
        const match = /^gitdir:\s*(.+?)\s*$/im.exec(text ?? "")
        if (!match) return undefined
        gitDir = resolve(dir, match[1]!)
      }
      const commonText = await readText(join(gitDir, "commondir"))
      const commonDir = commonText ? resolve(gitDir, commonText.trim()) : gitDir
      return { root: dir, gitDir, commonDir }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
  }
}

async function readIgnoreFile(file: string, sourceDir: string): Promise<IgnoreRule[]> {
  const text = await readText(file)
  if (text === undefined) return []
  const rules: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    let pattern = raw.trimEnd()
    if (!pattern || pattern.startsWith("#")) continue
    if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) pattern = pattern.slice(1)
    let negated = false
    if (pattern.startsWith("!")) {
      negated = true
      pattern = pattern.slice(1)
    }
    const directoryOnly = pattern.endsWith("/")
    if (directoryOnly) pattern = pattern.slice(0, -1)
    const anchored = pattern.startsWith("/")
    if (anchored) pattern = pattern.slice(1)
    if (!pattern) continue
    rules.push({
      sourceDir,
      pattern,
      negated,
      directoryOnly,
      anchored,
      hasSlash: pattern.includes("/"),
      regex: globRegex(pattern),
    })
  }
  return rules
}

function ignored(abs: string, directory: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false
  for (const rule of rules) {
    const rel = relative(rule.sourceDir, abs).replaceAll("\\", "/")
    if (!rel || rel.startsWith("../") || isAbsolute(rel)) continue
    if (rule.directoryOnly && !directory) continue
    const match =
      rule.hasSlash || rule.anchored
        ? rule.regex.test(rel)
        : rel.split("/").some((part) => rule.regex.test(part))
    if (match) ignored = !rule.negated
  }
  return ignored
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

async function hasGitEntry(dir: string): Promise<boolean> {
  return (await statOrNull(join(dir, ".git"))) !== null
}
