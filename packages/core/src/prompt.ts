import os from "node:os"

export interface PromptSection {
  name: string
  text: string
}

export interface PromptEnv {
  cwd: string
  shell?: string
  date?: Date
}

const IDENTITY = `You are Amira, a coding agent working in the user's terminal.
You help with software engineering tasks: reading and changing code, running commands, and explaining what you find.

- Use the tools to inspect the project before changing it. Prefer reading over guessing.
- Keep changes focused on what was asked. Match the surrounding code's style.
- When you run commands, prefer non-interactive forms and explain anything destructive before doing it.
- Be concise. Report what you changed and anything that failed.`

/** Default sections in a stable order, so the prompt prefix stays cacheable. */
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
  ]
}

export function renderPrompt(sections: PromptSection[]): string {
  return sections
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n\n")
}
