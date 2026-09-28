import type { CommandContext } from "./commands.ts"

/**
 * A skill the user runs by typing `$<name> [arguments]`. Skills live apart from slash
 * commands: `/` runs only commands, `$` only skills. The skills extension registers every
 * skill it finds this way (D27); what the model may load is up to the extension.
 */
export interface SkillDefinition {
  /** Typed after the `$`: no whitespace. */
  name: string
  description: string
  /** Shown after the name in lists. Default "[arguments]". */
  hint?: string
  /** Must be true to replace a skill of the same name registered earlier. */
  override?: boolean
  /**
   * `args` is the text after the name, trimmed. Usually sends the skill's instructions with
   * `ctx.session.send`. Throwing reports the message to the user.
   */
  run(args: string, ctx: CommandContext): void | Promise<void>
}

/** A registered skill, as frontends list it. */
export interface SkillInfo {
  name: string
  description: string
  hint?: string
  /** The extension that registered it. */
  source: string
}
