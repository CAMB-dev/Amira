import { existsSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import { dirname, join, resolve } from "node:path"
import type { SystemSection } from "@amira/api"

/** The same shape extensions see in the system.build interceptor. */
export type PromptSection = SystemSection

export interface PromptEnv {
  cwd: string
  shell?: string
  date?: Date
  nonInteractive?: boolean
  /** Text of the "project" section, e.g. from instructionsSection(). */
  project?: string
  /** Text of the "role" section, e.g. a sub-agent's role. */
  role?: string
}

/** Section names in prompt order (D43). Other names go after these. */
export const SECTION_ORDER = ["identity", "environment", "project", "skills", "deferred-tools", "mcp", "role"]

const IDENTITY = `You are Amira, a coding agent working in the user's terminal.
You help with software engineering tasks: reading and changing code, running commands, and explaining what you find.

- Use the tools to inspect the project before changing it. Prefer reading over guessing.
- Reproduce or confirm a reported problem before fixing it. If it does not reproduce or rests on a wrong assumption, say so plainly at the top of your reply.
- Keep changes focused on what was asked. Match the surrounding code's style.
- After changing code, run the relevant checks. If a check fails and you fix it, re-run what failed before finishing.
- Use a sub-agent for review only when the change is large or risky, not for small or mechanical edits.
- When you run commands, prefer non-interactive forms and explain anything destructive before doing it.
- Be concise. Report changes and check results honestly, including anything not verified.`

/** The line shared by non-interactive roots and the fresh sub-agents they create. */
export const NON_INTERACTIVE_LINE =
  "Run mode: non-interactive; decide for yourself instead of asking the user."

/**
 * Default sections in a stable order, so the prompt prefix stays cacheable. "skills" and
 * "deferred-tools" start empty; extensions fill them through the system.build interceptor.
 */
export function defaultSections(env: PromptEnv): PromptSection[] {
  const date = (env.date ?? new Date()).toISOString().slice(0, 10)
  const worktree = gitWorktreeLines(env.cwd)
  const lines = [
    `Working directory: ${env.cwd}`,
    ...worktree,
    `Platform: ${process.platform} (${os.release()})`,
    ...(env.shell ? [`Shell used by the bash tool: ${env.shell}`] : []),
    `Today's date: ${date}`,
    ...(env.nonInteractive ? [NON_INTERACTIVE_LINE] : []),
  ]
  return [
    { name: "identity", text: IDENTITY },
    { name: "environment", text: `# Environment\n${lines.join("\n")}` },
    { name: "project", text: env.project ?? "" },
    { name: "skills", text: "" },
    { name: "deferred-tools", text: "" },
    { name: "role", text: env.role ?? "" },
  ]
}

/** Identifies linked worktrees so the model does not accidentally edit the main checkout. */
function gitWorktreeLines(cwd: string): string[] {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git")
    try {
      if (statSync(dotGit).isFile()) {
        const text = readFileSync(dotGit, "utf8")
        const gitDir = /^gitdir:\s*(.+?)\s*$/im.exec(text)?.[1]
        if (gitDir) {
          const commonText = existsSync(join(resolve(dir, gitDir), "commondir"))
            ? readFileSync(join(resolve(dir, gitDir), "commondir"), "utf8").trim()
            : ""
          if (commonText) {
            const mainCheckout = dirname(resolve(dir, gitDir, commonText))
            return [
              "Git workspace: linked worktree",
              `Main checkout: ${mainCheckout} (off-limits for changes unless the user explicitly asks)`,
            ]
          }
        }
      }
    } catch {
      // Prompt construction should remain available even if Git metadata is incomplete.
    }
    const parent = dirname(dir)
    if (parent === dir) return []
  }
}

/** Adds the non-interactive instruction without replacing a child's other prompt sections. */
export function addNonInteractive(sections: PromptSection[]): PromptSection[] {
  const environment = sections.find((s) => s.name === "environment")
  if (environment?.text.includes(NON_INTERACTIVE_LINE)) return sections
  return setSection(
    sections,
    "environment",
    [environment?.text, NON_INTERACTIVE_LINE].filter(Boolean).join("\n"),
  )
}

/** Replaces the named section, or inserts it at its place in SECTION_ORDER. */
export function setSection(sections: PromptSection[], name: string, text: string): PromptSection[] {
  if (sections.some((s) => s.name === name))
    return sections.map((s) => (s.name === name ? { name, text } : s))
  const rank = (n: string) => {
    const i = SECTION_ORDER.indexOf(n)
    return i === -1 ? SECTION_ORDER.length : i
  }
  const at = sections.findIndex((s) => rank(s.name) > rank(name))
  const out = [...sections]
  out.splice(at === -1 ? out.length : at, 0, { name, text })
  return out
}

export function renderPrompt(sections: PromptSection[]): string {
  return sections
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n\n")
}
