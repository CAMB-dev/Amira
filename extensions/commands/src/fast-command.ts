import { type CommandContext, type CommandDefinition, modelLabel } from "@amira/api"

/**
 * "Requested" is the user's /fast choice; "applied" is whether the current model and provider
 * support it, so the request really carries the fast option; the last response reports the
 * tier the provider actually used.
 */
function report(ctx: CommandContext): void {
  const info = ctx.session.info()
  const { requested, applied, used, pricingUnknown, unavailableReason } = info.fastMode ?? {
    requested: false,
    applied: false,
  }
  const model = modelLabel(info.model)
  const state = !requested
    ? "Fast mode is off."
    : applied
      ? `Fast mode is on for ${model}.`
      : `Fast mode is on, but ${model} does not support it${unavailableReason ? ` (${unavailableReason})` : ""}; it takes effect on a supported model.`
  const pricing = pricingUnknown ? " Premium pricing unknown; costs use a standard-rate estimate." : ""
  ctx.print(`${state} Last response: ${used ?? "not reported"}.${pricing}`)
}

export function fastCommand(): CommandDefinition {
  return {
    name: "fast",
    description: "Toggle fast mode, set it on or off, or show status",
    args: {
      hint: "[on|off|status]",
      complete: () => [
        { value: "on", description: "Request fast mode" },
        { value: "off", description: "Stop requesting fast mode" },
        {
          value: "status",
          description: "Show whether fast mode is on and applied, and the last response's tier",
        },
      ],
    },
    run(args, ctx) {
      if (args && args !== "on" && args !== "off" && args !== "status")
        throw new Error("Usage: /fast [on|off|status]")
      if (args !== "status") {
        const current = ctx.session.info().fastMode?.requested ?? false
        const enabled = args ? args === "on" : !current
        if (enabled !== current) {
          ctx.session.setFastMode(enabled)
          report(ctx)
          ctx.print("Changing fast mode may invalidate the prompt cache.")
          return
        }
      }
      report(ctx)
    },
  }
}
