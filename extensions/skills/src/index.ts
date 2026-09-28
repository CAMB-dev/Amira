import {
  defineExtension,
  defineTool,
  type ExtensionAPI,
  type MessageDisplay,
  textResult,
  withSection,
} from "@amira/api"
import { type DiscoverOptions, discoverSkills, readSkillBody, type Skill } from "./discover.ts"

export {
  type DiscoverOptions,
  type Discovery,
  discoverSkills,
  readSkillBody,
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
 * What a skill run as a slash command (or by the model) receives: its instructions, where its
 * files live, and any arguments the user gave.
 */
export function skillPrompt(skill: Skill, args = ""): string {
  const parts = [`Skill "${skill.name}" (base directory: ${skill.dir})`, readSkillBody(skill)]
  if (args.trim()) parts.push(`Arguments: ${args.trim()}`)
  return parts.join("\n\n")
}

/** How a skill run as a slash command shows in the transcript: the command, then what it loaded. */
export function skillDisplay(skill: Skill, args = ""): MessageDisplay {
  const lines = readSkillBody(skill).split("\n").length
  const typed = `/${skill.name}${args.trim() ? ` ${args.trim()}` : ""}`
  return { text: typed, note: `Loaded skill ${skill.name} (${lines} line${lines === 1 ? "" : "s"})` }
}

export function createSkillsExtension(opts: Partial<DiscoverOptions> = {}) {
  return defineExtension((api: ExtensionAPI) => {
    const dirs = api.settings.skills?.dirs
    const where: DiscoverOptions = { cwd: api.cwd, home: api.home, ...(dirs ? { dirs } : {}), ...opts }
    const reported = new Set<string>()
    let skills: Skill[] = []
    let registered = false
    /** Skills already offered as slash commands (or refused, e.g. for a taken name). */
    const commands = new Set<string>()
    // Rescanned before every model call, so skills written during a session are listed (and
    // the tool appears) right away; the listing only changes when the skills do.
    const scan = () => {
      const found = discoverSkills(where)
      for (const p of found.problems) {
        if (reported.has(p)) continue
        reported.add(p)
        api.reportError(`skipped skill ${p}`)
      }
      skills = found.skills
      if (!registered && skills.some((s) => !s.userOnly)) {
        registered = true
        api.registerTool(skillTool)
      }
      for (const s of skills) addCommand(s.name)
      return skills
    }

    // Every skill is also /<name>, user-only ones included: that is how the user runs them.
    const addCommand = (name: string) => {
      if (commands.has(name)) return
      commands.add(name)
      api.registerCommand({
        name,
        description: `Skill: ${skills.find((s) => s.name === name)?.description ?? name}`,
        args: { hint: "[arguments]" },
        async run(args, ctx) {
          const skill = skills.find((s) => s.name === name) ?? scan().find((s) => s.name === name)
          if (!skill) throw new Error(`the skill "${name}" is gone`)
          const prompt = skillPrompt(skill, args)
          // The transcript shows the command as typed, not the skill's whole text.
          await ctx.session.send(prompt, { display: skillDisplay(skill, args) })
        },
      })
    }

    const find = (name: string) => {
      const hit = skills.find((s) => s.name === name && !s.userOnly)
      if (hit) return hit
      return scan().find((s) => s.name === name && !s.userOnly)
    }

    const skillTool = defineTool<{ name: string; args?: string }>({
      name: SKILL_TOOL,
      description: `Loads a skill's full instructions by name. Skills are listed in the system prompt under "Skills"; use one when a task matches its description.`,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The skill's name, as listed." },
          args: { type: "string", description: "Optional arguments or context for the skill." },
        },
        required: ["name"],
      },
      concurrency: "parallel",
      async execute(p) {
        const skill = find(p.name.trim())
        if (!skill) {
          const names = skills.filter((s) => !s.userOnly).map((s) => s.name)
          return textResult(`No skill named "${p.name}". Available skills: ${names.join(", ")}`, true)
        }
        try {
          return textResult(skillPrompt(skill, p.args))
        } catch (err) {
          return textResult(`Could not read ${skill.path}: ${err instanceof Error ? err.message : err}`, true)
        }
      },
    })

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
