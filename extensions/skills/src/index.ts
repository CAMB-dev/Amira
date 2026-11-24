import {
  type CommandDefinition,
  defineExtension,
  defineTool,
  type ExtensionAPI,
  type MessageDisplay,
  plural,
  type ToolPresenter,
  textResult,
  withSection,
} from "@amira/api"
import {
  type DiscoverOptions,
  discoverSkills,
  readSkillBody,
  type ShadowedSkill,
  type Skill,
} from "./discover.ts"

export {
  type DiscoverOptions,
  type Discovery,
  discoverSkills,
  readSkillBody,
  type ShadowedSkill,
  type Skill,
  skillRoots,
} from "./discover.ts"
export { parseFrontmatter } from "./frontmatter.ts"

export const SKILL_TOOL = "skill"

/** The system prompt block listing the skills the model may use; empty when there are none. */
export function skillsSection(skills: Skill[]): string {
  const usable = skills.filter((s) => !s.userOnly)
  if (!usable.length) return ""
  return [
    "# Skills",
    `Skills are packaged instructions for particular tasks, written by the user or their team. Whenever a request matches a skill's description, call the ${SKILL_TOOL} tool with its name before doing anything else, then follow the instructions it returns over your own defaults.`,
    ...usable.map((s) => `- ${s.name}: ${s.description} (${s.path})`),
  ].join("\n")
}

/**
 * What a skill run as `$<name>` (or by the model) receives: its instructions, where its files
 * live, and any arguments the user gave.
 */
export function skillPrompt(skill: Skill, args = ""): string {
  return skillPromptWithBody(skill, readSkillBody(skill), args)
}

function skillPromptWithBody(skill: Skill, body: string, args = ""): string {
  const parts = [`Skill "${skill.name}" (base directory: ${skill.dir})`, body]
  if (args.trim()) parts.push(`Arguments: ${args.trim()}`)
  return parts.join("\n\n")
}

function bodyLineCount(body: string): number {
  return body ? body.split("\n").length : 0
}

/**
 * The skill's prompt, or a short note when its instructions are still in the context the model
 * sees (not compacted or aged away); the arguments are passed either way.
 */
function loadPrompt(
  skill: Skill,
  args: string | undefined,
  inContext: (text: string) => boolean,
): { prompt: string; reused: boolean; lines: number } {
  const body = readSkillBody(skill)
  const lines = bodyLineCount(body)
  if (!body || !inContext(body)) {
    return { prompt: skillPromptWithBody(skill, body, args), reused: false, lines }
  }
  const parts = [`Skill "${skill.name}" is already loaded in the current context.`]
  if (args?.trim()) parts.push(`Arguments: ${args.trim()}`)
  return { prompt: parts.join("\n\n"), reused: true, lines }
}

/** How a skill run as `$<name>` shows in the transcript: the line as typed, then what it loaded. */
export function skillDisplay(
  skill: Skill,
  args = "",
  loaded?: { reused?: boolean; lines?: number },
): MessageDisplay {
  const typed = `$${skill.name}${args.trim() ? ` ${args.trim()}` : ""}`
  if (loaded?.reused) {
    return { text: typed, note: `Skill ${skill.name} (already in context)` }
  }
  const lines = loaded?.lines ?? bodyLineCount(readSkillBody(skill))
  return { text: typed, note: `Loaded skill ${skill.name} (${plural(lines, "line")})` }
}

export const skillToolPresenter: ToolPresenter<{ name?: string; args?: string }> = {
  verbs: { past: "Loaded skill", running: "Loading skill" },
  summary: (args) =>
    `${typeof args.name === "string" ? args.name : ""}${typeof args.args === "string" && args.args.trim() ? ` ${args.args.trim()}` : ""}`.trim(),
  result(call) {
    if (call.result.isError) return undefined
    if (call.text.includes("is already loaded in the current context.")) return "already in context"
    const body = call.text.split("\n\n").slice(1).join("\n\n")
    return plural(bodyLineCount(body), "line")
  },
  body(call, { detail }) {
    if (detail !== "full" || call.result.isError) return []
    return call.text.split("\n").map((text) => ({ kind: "text", text, wrap: true }))
  },
}

export function createSkillsExtension(opts: Partial<DiscoverOptions> = {}) {
  return defineExtension((api: ExtensionAPI) => {
    const dirs = api.settings.skills?.dirs
    const where: DiscoverOptions = { cwd: api.cwd, home: api.home, ...(dirs ? { dirs } : {}), ...opts }
    const reported = new Set<string>()
    let skills: Skill[] = []
    let lastProblems: string[] = []
    let lastShadowed: ShadowedSkill[] = []
    let registered = false
    /** Skills currently registered to run as `$<name>`, with their disposers for dynamic updates. */
    const offered = new Map<string, { description: string; dispose: () => void }>()

    const registerOne = (found: Skill) => {
      const { name, description } = found
      const dispose = api.registerSkill({
        name,
        description,
        async run(args, ctx) {
          const skill = skills.find((s) => s.name === name) ?? scan().find((s) => s.name === name)
          if (!skill) throw new Error(`the skill "${name}" is gone`)
          const loaded = loadPrompt(skill, args, (text) => ctx.session.contextHas?.(text) === true)
          // The transcript shows the skill as typed, not its whole text.
          await ctx.session.send(loaded.prompt, { display: skillDisplay(skill, args, loaded) })
        },
      })
      offered.set(name, { description, dispose })
    }

    // Rescanned before every model call (and on /skills), so skills added, edited or deleted
    // during a session stay in sync without requiring a full /reload.
    const scan = () => {
      const found = discoverSkills(where)
      const activeProblems = new Set(found.problems)
      for (const old of [...reported]) if (!activeProblems.has(old)) reported.delete(old)
      for (const p of found.problems) {
        if (reported.has(p)) continue
        reported.add(p)
        api.reportError(`skipped skill ${p}`)
      }
      skills = found.skills
      lastProblems = found.problems
      lastShadowed = found.shadowed ?? []
      if (!registered && skills.some((s) => !s.userOnly)) {
        registered = true
        api.registerTool(skillTool)
        api.registerToolRenderer(SKILL_TOOL, skillToolPresenter)
      }
      const nextByName = new Map(skills.map((s) => [s.name, s]))
      for (const [name, entry] of [...offered.entries()]) {
        const next = nextByName.get(name)
        if (!next) {
          entry.dispose()
          offered.delete(name)
        } else if (next.description !== entry.description) {
          entry.dispose()
          offered.delete(name)
          registerOne(next)
        }
      }
      for (const s of skills) if (!offered.has(s.name)) registerOne(s)
      return skills
    }

    const find = (name: string) => {
      const hit = skills.find((s) => s.name === name && !s.userOnly)
      if (hit) return hit
      return scan().find((s) => s.name === name && !s.userOnly)
    }

    const skillTool = defineTool<{ name: string; args?: string }>({
      name: SKILL_TOOL,
      description: `Load full instructions by name from system "Skills" when a task matches.`,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          args: { type: "string", description: "Arguments/context for the skill." },
        },
        required: ["name"],
      },
      traits: { readOnly: true },
      concurrency: "parallel",
      async execute(p, ctx) {
        const skill = find(p.name.trim())
        if (!skill) {
          const names = skills.filter((s) => !s.userOnly).map((s) => s.name)
          return textResult(
            names.length
              ? `No skill named "${p.name}". Available skills: ${names.join(", ")}`
              : `No skill named "${p.name}". No model-invocable skills are available.`,
            true,
          )
        }
        try {
          return textResult(
            loadPrompt(skill, p.args, (text) => ctx.session?.contextHas?.(text) === true).prompt,
          )
        } catch (err) {
          return textResult(`Could not read ${skill.path}: ${err instanceof Error ? err.message : err}`, true)
        }
      },
    })

    const skillsCmd: CommandDefinition = {
      name: "skills",
      description: "List discovered skills, rescan skill directories, or inspect one skill",
      args: {
        hint: "[reload|<name>]",
        complete: () => [
          { value: "reload", description: "Rescan skill directories for added, edited or removed skills" },
          ...skills.map((s) => ({
            value: s.name,
            description: `${s.userOnly ? "[user-only] " : ""}${s.description}`,
          })),
        ],
      },
      run(args, ctx) {
        const sep = ctx.glyphs?.().separator ?? "·"
        const arg = args.trim()
        const current = scan()
        if (arg === "reload") {
          ctx.print(
            `Rescanned skills: ${plural(current.length, "skill")} found${lastProblems.length ? ` ${sep} ${plural(lastProblems.length, "problem")}` : ""}.`,
            lastProblems.length ? "warning" : "info",
          )
          return
        }
        if (arg) {
          const match = current.find((s) => s.name === arg)
          if (!match) throw new Error(`No skill named "${arg}". Run /skills to list available skills.`)
          const lines = bodyLineCount(readSkillBody(match))
          ctx.print(
            [
              `$${match.name}${match.userOnly ? " (user-only)" : ""}`,
              match.description,
              `Path:  ${match.path}`,
              `Lines: ${lines}`,
            ].join("\n"),
          )
          return
        }
        if (!current.length && !lastProblems.length) {
          ctx.print("No skills found. Add <dir>/<name>/SKILL.md under .amira/skills or ~/.amira/skills.")
          return
        }
        const sections: string[] = []
        if (current.length) {
          sections.push(
            `Skills (${current.length}; run with $<name> [arguments]):\n${current
              .map(
                (s) =>
                  `  $${s.name}${s.userOnly ? " [user-only]" : ""} ${sep} ${s.description}\n    ${s.path}`,
              )
              .join("\n")}`,
          )
        }
        if (lastShadowed.length) {
          sections.push(
            `Shadowed (${lastShadowed.length}):\n${lastShadowed
              .map((s) => `  $${s.name} ${sep} ${s.path} (shadowed by ${s.winner})`)
              .join("\n")}`,
          )
        }
        if (lastProblems.length) {
          ctx.print(sections.join("\n\n"))
          ctx.print(
            `Problems (${lastProblems.length}):\n${lastProblems.map((p) => `  ${p}`).join("\n")}`,
            "warning",
          )
          return
        }
        ctx.print(sections.join("\n\n"))
      },
    }

    api.registerCommand(skillsCmd)
    scan()
    // Fills the prompt's "skills" section (D43), which keeps its place in the prompt.
    api.intercept("system.build", (ctx) => {
      const section = skillsSection(scan())
      if (!section) return { action: "pass" }
      return { action: "modify", value: { sections: withSection(ctx.sections, "skills", section) } }
    })
  })
}

export default createSkillsExtension()
