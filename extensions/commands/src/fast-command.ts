import { type CommandContext, type CommandDefinition, modelLabel } from "@amira/api"

function report(ctx: CommandContext): void {
  const info = ctx.session.info()
  const { requested, applied, used, pricingUnknown, unavailableReason } = info.fastMode ?? {
    requested: false,
    applied: false,
  }
  const unavailable =
    requested && !applied
      ? ` Unavailable for ${modelLabel(info.model)}${unavailableReason ? ` (${unavailableReason})` : ""}; request kept for a supported model/provider.`
      : ""
  const pricing = pricingUnknown ? " Premium pricing unknown; costs use a standard-rate estimate." : ""
  ctx.print(
    `Fast mode: requested ${requested ? "on" : "off"}; applied ${applied ? "on" : "off"}; last used ${used ?? "not reported"}.${unavailable}${pricing}`,
  )
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
        { value: "status", description: "Show requested, applied and last-used mode" },
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
