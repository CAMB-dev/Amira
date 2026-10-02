import { type CommandContext, type CommandDefinition, modelLabel, type ReasoningEffort } from "@amira/api"

const LEVELS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"]
const CHOICES = [...LEVELS, "default"]

function label(level: ReasoningEffort | undefined): string {
  return level ?? "default (not sent)"
}

function report(ctx: CommandContext): void {
  const info = ctx.session.info()
  ctx.print(
    `Thinking: ${label(info.thinkingLevel)}${
      info.supportsThinking === false
        ? `. Model ${modelLabel(info.model)} doesn't think; choice kept for a thinking model.`
        : ""
    }`,
  )
}

/** Shared by /thinking and the second step of the interactive model picker. */
export async function pickThinking(ctx: CommandContext): Promise<void> {
  const current = ctx.session.info().thinkingLevel
  const levels = [...LEVELS, undefined]
  const options = levels.map((level) => `${label(level)}${level === current ? " (current)" : ""}`)
  const picked = await ctx.ui.select("Thinking effort", options, {
    signal: ctx.signal,
    initial: options[levels.indexOf(current)]!,
  })
  if (picked === undefined) return
  ctx.session.setThinking(levels[options.indexOf(picked)])
  // The TUI echoes the choice, but still needs to explain a non-thinking model.
  if (ctx.frontend !== "tui" || ctx.session.info().supportsThinking === false) report(ctx)
}

export function thinkingCommand(): CommandDefinition {
  return {
    name: "thinking",
    description: "Set thinking effort, or pick a level",
    args: {
      hint: "[low|medium|high|xhigh|max|default]",
      complete: (_prefix, ctx) => {
        const current = ctx.session.info().thinkingLevel ?? "default"
        return CHOICES.map((value) => ({
          value,
          ...(value === current
            ? { description: value === "default" ? "current; not sent" : "current" }
            : value === "default"
              ? { description: "not sent" }
              : {}),
        }))
      },
    },
    async run(args, ctx) {
      if (!args) return pickThinking(ctx)
      const level = LEVELS.find((value) => value === args)
      if (level === undefined && args !== "default")
        throw new Error(`Choose thinking effort: ${CHOICES.join(", ")}`)
      ctx.session.setThinking(level)
      report(ctx)
    },
  }
}
