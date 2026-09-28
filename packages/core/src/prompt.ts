import os from "node:os"

export interface PromptSection {
  name: string
  text: string
}

export interface PromptEnv {
  cwd: string
  shell?: string
  date?: Date
  /** Text of the "project" section, e.g. from instructionsSection(). */
  project?: string
  /** Text of the "role" section, e.g. a sub-agent's role. */
  role?: string
}

/** Section names in prompt order (D43). Other names go after these. */
export const SECTION_ORDER = ["identity", "environment", "project", "skills", "deferred-tools", "role"]

const IDENTITY = `You are Amira, a coding agent working in the user's terminal.
You help with software engineering tasks: reading and changing code, running commands, and explaining what you find.

- Use the tools to inspect the project before changing it. Prefer reading over guessing.
- Keep changes focused on what was asked. Match the surrounding code's style.
- When you run commands, prefer non-interactive forms and explain anything destructive before doing it.
- Be concise. Report what you changed and anything that failed.`

/**
 * Default sections in a stable order, so the prompt prefix stays cacheable. "skills" and
 * "deferred-tools" start empty; extensions fill them through the system.build interceptor.
 */
export function defaultSections(env: PromptEnv): PromptSection[] {
  const date = (env.date ?? new Date()).toISOString().slice(0, 10)
  const lines = [
    `Working directory: ${env.cwd}`,
    `Platform: ${process.platform} (${os.release()})`,
    ...(env.shell ? [`Shell used by the bash tool: ${env.shell}`] : []),
    `Today's date: ${date}`,
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
