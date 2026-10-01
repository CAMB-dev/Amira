import type { CommandDefinition, ShellMode } from "@amira/api"

const SHELLS: ShellMode[] = ["auto", "bash", "powershell"]

export function shellCommand(): CommandDefinition {
  return {
    name: "shell",
    description: "Show or set which shell tools the model gets",
    args: {
      hint: "[auto|bash|powershell]",
      complete: () =>
        SHELLS.map((value) => ({
          value,
          description: value === "auto" ? "every shell tool this system has" : `only the ${value} tool`,
        })),
    },
    run(args, ctx) {
      if (args) ctx.session.setShell(args as ShellMode)
      const shell = ctx.session.info().shell
      const on = ctx.session
        .tools()
        .filter((t) => t.traits?.shell && t.enabled)
        .map((t) => t.name)
      ctx.print(`Shell: ${shell} (tools: ${on.join(", ") || "none"})`)
    },
  }
}
