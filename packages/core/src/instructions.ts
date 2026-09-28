import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { amiraHome } from "./home.ts"

/** Checked in this order in each directory; the first that exists wins (D58). */
export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]

export interface InstructionFile {
  path: string
  text: string
}

/**
 * Project instructions (D20): `~/.amira/AGENTS.md` first, then one file per directory from
 * the repository root (or the filesystem root outside a repository) down to cwd, so
 * deeper files come later and can refine what their parents say.
 */
export function loadInstructions(cwd: string, home = amiraHome()): InstructionFile[] {
  const out: InstructionFile[] = []
  const user = readText(path.join(home, "AGENTS.md"))
  if (user !== undefined) out.push({ path: path.join(home, "AGENTS.md"), text: user })
  for (const dir of dirsFromRoot(path.resolve(cwd))) {
    for (const name of INSTRUCTION_FILES) {
      const file = path.join(dir, name)
      const text = readText(file)
      if (text === undefined) continue
      out.push({ path: file, text })
      break
    }
  }
  return out
}

/** The text of the "project" system prompt section, or "" when there are no instructions. */
export function instructionsSection(files: InstructionFile[]): string {
  const parts = files.filter((f) => f.text.trim()).map((f) => `## ${f.path}\n\n${f.text.trim()}`)
  if (!parts.length) return ""
  return `# Project instructions\nFollow these instructions from the user and the project. Later (deeper) files take precedence.\n\n${parts.join("\n\n")}`
}

/** Directories from the repository root (or filesystem root) down to dir. */
function dirsFromRoot(dir: string): string[] {
  const chain: string[] = []
  for (let d = dir; ; d = path.dirname(d)) {
    chain.push(d)
    if (existsSync(path.join(d, ".git")) || path.dirname(d) === d) break
  }
  return chain.reverse()
}

function readText(file: string): string | undefined {
  try {
    if (!statSync(file).isFile()) return undefined
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}
