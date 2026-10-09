import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

export type Isolation = "none" | "worktree"

/** A sub-agent role (D12, D61): a Markdown file whose body becomes the child's instructions. */
export interface Role {
  name: string
  description: string
  /** "provider/model"; settings `agents.<name>.model` wins over it. */
  model?: string
  /** Tools the role may use. Unset: every tool the commander has. */
  tools?: string[]
  isolation?: Isolation
  prompt: string
  /** "built-in", or the file it came from. */
  source: string
}

/** Read-only work may still inspect with the shell; the prompt keeps it to commands that change nothing. */
const READ_ONLY_TOOLS = ["read", "grep", "glob", "bash", "powershell", "web_search", "web_fetch"]

const READ_ONLY_RULE =
  "Do not change anything: no file edits, and only shell commands that read (listing files, git status/log/diff/show, printing versions). Never run commands that write, install, delete or commit."

export const BUILTIN_ROLES: Role[] = [
  {
    name: "explorer",
    description: "Read-only code research, tracing and project questions.",
    tools: READ_ONLY_TOOLS,
    prompt: `You are an explorer. Investigate the codebase to answer the task.
${READ_ONLY_RULE}
Finish with a concise report: the answer, the relevant file paths (with line numbers where useful), and anything you are unsure about.`,
    source: "built-in",
  },
  {
    name: "coder",
    description: "Implements specified changes; all tools.",
    prompt: `You are a coder. Implement exactly what the task specifies, matching the surrounding code's style, and nothing more.
Check your change when it is practical (type check, tests, running it).
Finish with the outcome, then summarize in three sentences what you changed.`,
    source: "built-in",
  },
  {
    name: "reviewer",
    description: "Read-only code/change correctness review.",
    tools: READ_ONLY_TOOLS,
    prompt: `You are a reviewer. Review the code or change named in the task for correctness: bugs, unhandled edge cases, broken contracts, missing error handling, tests that do not test what they claim.
${READ_ONLY_RULE}
Report findings most severe first, each with file:line, what is wrong and a concrete input or sequence that triggers it. Say plainly when you find nothing.`,
    source: "built-in",
  },
]

/** Splits `---` YAML frontmatter from a Markdown document. Throws on invalid YAML. */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const src = text.replace(/^﻿/, "")
  const match = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(src)
  if (!match) return { data: {}, body: src }
  const yaml = match[1] ?? ""
  const parsed = yaml.trim() ? Bun.YAML.parse(yaml) : {}
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  return { data: data as Record<string, unknown>, body: src.slice(match[0].length) }
}

/** Parses one role file. The name defaults to the file name; tools may be a list or "a, b". */
export function parseRole(text: string, file: string): Role {
  const { data, body } = parseFrontmatter(text)
  const str = (key: string) => {
    const v = data[key]
    if (v === undefined || v === null) return undefined
    if (typeof v !== "string") throw new Error(`"${key}" must be a string`)
    return v.trim() || undefined
  }
  const name = str("name") ?? path.basename(file, path.extname(file))
  if (!/^[\w.-]+$/.test(name))
    throw new Error(`role name "${name}" may only use letters, digits, "_", "-" and "."`)
  let tools: string[] | undefined
  const rawTools = data.tools
  if (typeof rawTools === "string") tools = rawTools.split(/[,\s]+/).filter(Boolean)
  else if (Array.isArray(rawTools) && rawTools.every((t) => typeof t === "string")) tools = rawTools
  else if (rawTools !== undefined && rawTools !== null)
    throw new Error(`"tools" must be a list of tool names`)
  const isolation = str("isolation")
  if (isolation !== undefined && isolation !== "none" && isolation !== "worktree") {
    throw new Error(`"isolation" must be "none" or "worktree", got "${isolation}"`)
  }
  const model = str("model")
  if (model !== undefined && !/^[^/]+\/.+/.test(model))
    throw new Error(`"model" must look like "provider/model"`)
  return {
    name,
    description: str("description") ?? "",
    ...(model ? { model } : {}),
    ...(tools ? { tools } : {}),
    ...(isolation ? { isolation: isolation as Isolation } : {}),
    prompt: body.trim(),
    source: file,
  }
}

export interface RoleDirs {
  /** Amira's user directory (`~/.amira`). */
  home: string
  cwd: string
}

/** Where role files are looked for, lowest precedence first: user, then project. */
export function roleDirs(dirs: RoleDirs): string[] {
  return [path.join(dirs.home, "agents"), path.join(dirs.cwd, ".amira", "agents")]
}

/**
 * Every role by name: the built-in ones, then `~/.amira/agents/*.md`, then
 * `<project>/.amira/agents/*.md`; a later one replaces an earlier one of the same name.
 * Files that cannot be read or parsed are reported in `problems` and skipped.
 */
export function loadRoles(dirs: RoleDirs): { roles: Map<string, Role>; problems: string[] } {
  const roles = new Map(BUILTIN_ROLES.map((r) => [r.name, r]))
  const problems: string[] = []
  for (const dir of roleDirs(dirs)) {
    let names: string[]
    try {
      names = readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith(".md"))
        .sort()
    } catch {
      continue
    }
    for (const n of names) {
      const file = path.join(dir, n)
      try {
        const role = parseRole(readFileSync(file, "utf8"), file)
        roles.set(role.name, role)
      } catch (err) {
        problems.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return { roles, problems }
}

/**
 * The model a role runs on (D9, D61): the call's own choice, then settings
 * `agents.<role>.model`, then the role file; undefined means the commander's current model.
 */
export function roleModel(
  role: Role | undefined,
  callModel: string | undefined,
  settings: Record<string, { model?: string }> | undefined,
): string | undefined {
  if (callModel) return callModel
  if (role && settings && Object.hasOwn(settings, role.name) && settings[role.name]?.model) {
    return settings[role.name]!.model
  }
  return role?.model
}
