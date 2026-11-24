import { type CommandContext, type CommandDefinition, modelLabel } from "@amira/api"
import { pickThinking } from "./thinking-command.ts"

/**
 * Picks one of `models`, opening on the current one and marking it as the completion list
 * does; resolves with the model ref, or undefined when cancelled.
 */
export async function pickModel(
  ctx: CommandContext,
  title: string,
  models: string[],
): Promise<string | undefined> {
  const current = modelLabel(ctx.session.info().model)
  // Group by provider when multiple providers are present so long model lists stay scannable.
  const groups = new Map<string, string[]>()
  for (const model of models) {
    const slash = model.indexOf("/")
    const provider = slash > 0 ? model.slice(0, slash) : ""
    const list = groups.get(provider) ?? []
    list.push(model)
    groups.set(provider, list)
  }
  const multiProvider = groups.size > 1 && [...groups.keys()].every(Boolean)
  const ordered = multiProvider ? [...groups.values()].flat() : models
  const sections: { at: number; title?: string }[] = []
  if (multiProvider) {
    let at = 0
    for (const [provider, list] of groups) {
      sections.push({ at, title: provider })
      at += list.length
    }
  } else {
    sections.push({ at: 0 })
  }
  const pick = await ctx.ui.choose(title, ordered, {
    sections,
    ...(ordered.includes(current) ? { initial: current } : {}),
    descriptions: ordered.map((model) => (model === current ? "current" : "")),
    signal: ctx.signal,
  })
  return pick?.option
}

export function modelCommand(): CommandDefinition {
  return {
    name: "model",
    description: "Switch the model, or pick one",
    args: {
      hint: "[provider/model]",
      complete: (_prefix, ctx) => {
        const current = modelLabel(ctx.session.info().model)
        return ctx.session.models().map((value) => ({
          value,
          ...(value === current ? { description: "current" } : {}),
        }))
      },
    },
    async run(args, ctx) {
      const ref = args
      if (!ref) {
        const current = modelLabel(ctx.session.info().model)
        const models = ctx.session.models()
        if (!models.length) {
          throw new Error(
            ctx.session.providers().length
              ? "No models to pick from: list some with /provider edit <id>, store a key with /provider key <id>, or pass one: /model provider/model"
              : "No providers configured — add one with /provider add",
          )
        }
        const picked = await pickModel(ctx, "Choose a model", models)
        if (!picked) {
          // The TUI's picker leaves its own cancelled echo.
          if (ctx.frontend !== "tui")
            ctx.print(`Model: ${current}. Pass one to switch: /model provider/model`)
          return
        }
        // The same result line as a typed /model, in every frontend.
        ctx.session.setModel(picked)
        ctx.print(`Model: ${modelLabel(ctx.session.info().model)}`)
        if (ctx.session.info().supportsThinking) await pickThinking(ctx)
        return
      }
      ctx.session.setModel(ref)
      ctx.print(`Model: ${modelLabel(ctx.session.info().model)}`)
    },
  }
}
