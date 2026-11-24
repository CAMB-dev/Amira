import type { CommandContext, CommandDefinition } from "@amira/api"
import { oneLine, subcommandCandidates } from "./command-utils.ts"
import { table } from "./format.ts"

export function toolsCommand(): CommandDefinition {
  const toolNames = (ctx: { session: CommandContext["session"] }, enabled: boolean) => () =>
    ctx.session
      .tools()
      .filter((t) => t.enabled !== enabled)
      .map((t) => ({ value: t.name, description: t.source }))

  return {
    name: "tools",
    description: "List tools; enable or disable one for this session",
    args: {
      hint: "[enable|disable <name>]",
      complete: (prefix, ctx) =>
        subcommandCandidates(prefix, {
          disable: { description: "hide a tool from the model", values: toolNames(ctx, false) },
          enable: { description: "give a disabled tool back", values: toolNames(ctx, true) },
        }),
    },
    run(args, ctx) {
      const [sub, name, ...rest] = args.split(/\s+/).filter(Boolean)
      if (sub) {
        if ((sub !== "enable" && sub !== "disable") || !name || rest.length) {
          throw new Error("usage: /tools [enable|disable <name>]")
        }
        const enable = sub === "enable"
        const existing = ctx.session.tools().find((t) => t.name === name)
        if (existing && existing.enabled === enable) {
          ctx.print(`${name} is already ${enable ? "enabled" : "disabled"}.`)
          return
        }
        ctx.session.setToolEnabled(name, enable)
        ctx.print(`${enable ? "Enabled" : "Disabled"} ${name} for this session.`)
        return
      }
      const tools = ctx.session.tools()
      if (!tools.length) {
        ctx.print("No tools registered.")
        return
      }
      const hasDesc = tools.some((t) => t.description?.trim())
      const rows = tools.map((t) => [
        t.enabled ? "on" : "off",
        t.name,
        t.exposure === "active" ? t.source : `${t.source}, ${t.exposure}`,
        ...(hasDesc ? [t.description ? oneLine(t.description, 56) : ""] : []),
      ])
      const off = tools.filter((t) => !t.enabled).length
      ctx.print(`Tools (${tools.length - off} on, ${off} off):\n${table(rows)}`)
    },
  }
}
