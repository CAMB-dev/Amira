import { type CommandDefinition, modelLabel } from "@amira/api"

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
        const picked = await ctx.ui.select(`Model (now ${current})`, models, {
          signal: ctx.signal,
        })
        if (!picked) {
          ctx.print(`Model: ${current}. Pass one to switch: /model provider/model`)
          return
        }
        // The TUI's picker leaves an echo line that shows what was chosen; other frontends
        // get the model it came to.
        ctx.session.setModel(picked)
        if (ctx.frontend !== "tui") ctx.print(`Model: ${modelLabel(ctx.session.info().model)}`)
        return
      }
      ctx.session.setModel(ref)
      ctx.print(`Model: ${modelLabel(ctx.session.info().model)}`)
    },
  }
}
