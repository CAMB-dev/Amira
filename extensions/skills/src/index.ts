import { defineExtension, defineTool, type ExtensionAPI, textResult } from "@amira/api"
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

export function createSkillsExtension(opts: Partial<DiscoverOptions> = {}) {
  return defineExtension((api: ExtensionAPI) => {
    const where: DiscoverOptions = { cwd: api.cwd, home: api.home, ...opts }
    const found = discoverSkills(where)
    for (const p of found.problems) api.reportError(`skipped skill ${p}`)
    let skills = found.skills
    if (!skills.some((s) => !s.userOnly)) return

    const find = (name: string) => {
      const hit = skills.find((s) => s.name === name && !s.userOnly)
      if (hit) return hit
      // A skill added during the session is picked up on first use.
      skills = discoverSkills(where).skills
      return skills.find((s) => s.name === name && !s.userOnly)
    }

    api.registerTool(
      defineTool<{ name: string; args?: string }>({
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
            return textResult(
              `Could not read ${skill.path}: ${err instanceof Error ? err.message : err}`,
              true,
            )
          }
        },
      }),
    )

    // Until named prompt sections land, the listing is appended as its own block here.
    const section = skillsSection(skills)
    api.intercept("context.build", (ctx) => ({
      action: "modify",
      value: { ...ctx, systemPrompt: `${ctx.systemPrompt.trimEnd()}\n\n${section}` },
    }))
  })
}

export default createSkillsExtension()
