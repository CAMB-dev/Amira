import { readdirSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseFrontmatter } from "./frontmatter.ts"

export interface Skill {
  name: string
  description: string
  /** Absolute path of SKILL.md. */
  path: string
  /** The skill's directory; files it mentions are relative to it. */
  dir: string
  /** Which skills directory it came from. */
  root: string
  /** Every frontmatter field, including optional ones such as `allowed-tools`. */
  meta: Record<string, unknown>
  /** `disable-model-invocation: true`: only the user can run it (as `$<name>`). */
  userOnly: boolean
}

export interface DiscoverOptions {
  cwd: string
  /** Amira's user directory (`api.home`). */
  home: string
  /** The OS user's home, for ~/.claude/skills. Default os.homedir(). */
  userHome?: string
  /**
   * Extra skill directories from settings `skills.dirs`, searched after Amira's own. `~` is the
   * OS user's home; relative paths are resolved against `cwd`.
   */
  dirs?: string[]
}

export interface Discovery {
  skills: Skill[]
  /** Skills that could not be loaded, as "path: reason". */
  problems: string[]
}

/** Skill directories, highest precedence first: Amira's own directories win name clashes. */
export function skillRoots(opts: DiscoverOptions): string[] {
  const userHome = opts.userHome ?? os.homedir()
  return [
    path.join(opts.cwd, ".amira", "skills"),
    path.join(opts.home, "skills"),
    ...(opts.dirs ?? []).map((d) => path.resolve(opts.cwd, d.replace(/^~(?=$|[\\/])/, userHome))),
    path.join(opts.cwd, ".agents", "skills"),
    path.join(opts.cwd, ".claude", "skills"),
    path.join(userHome, ".claude", "skills"),
  ]
}

/**
 * Finds `<root>/<name>/SKILL.md` in every skill directory. The first skill found under a
 * name wins; later ones with the same name are shadowed silently. Sorted by name.
 */
export function discoverSkills(opts: DiscoverOptions): Discovery {
  const byName = new Map<string, Skill>()
  const problems: string[] = []
  const seenRoots = new Set<string>()
  for (const root of skillRoots(opts)) {
    const resolved = path.resolve(root)
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved
    if (seenRoots.has(key)) continue
    seenRoots.add(key)
    for (const entry of listDirs(root)) {
      const file = path.join(root, entry, "SKILL.md")
      let text: string
      try {
        if (!statSync(file).isFile()) continue
        text = readFileSync(file, "utf8")
      } catch {
        continue
      }
      const skill = toSkill(text, file, root, entry)
      if (typeof skill === "string") {
        problems.push(`${file}: ${skill}`)
        continue
      }
      if (!byName.has(skill.name)) byName.set(skill.name, skill)
    }
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { skills, problems }
}

/** The instructions of a skill, without its frontmatter. */
export function readSkillBody(skill: Skill): string {
  return parseFrontmatter(readFileSync(skill.path, "utf8")).body.trim().replace(/\r\n?/g, "\n")
}

function toSkill(text: string, file: string, root: string, dirName: string): Skill | string {
  let data: Record<string, unknown>
  try {
    data = parseFrontmatter(text).data
  } catch (err) {
    return `invalid frontmatter: ${err instanceof Error ? err.message : String(err)}`
  }
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : dirName
  if (/\s/.test(name)) return `invalid name "${name}" (no spaces allowed)`
  const description = typeof data.description === "string" ? data.description.replace(/\s+/g, " ").trim() : ""
  if (!description) return "missing description in frontmatter"
  return {
    name,
    description,
    path: file,
    dir: path.dirname(file),
    root,
    meta: data,
    userOnly: data["disable-model-invocation"] === true,
  }
}

function listDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}
