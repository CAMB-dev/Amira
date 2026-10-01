import type { CommandDefinition } from "@amira/api"
import { table } from "./format.ts"

export function permissionsCommand(): CommandDefinition {
  return {
    name: "permissions",
    description: "Show the permission mode, the command rules and where each comes from",
    run(_args, ctx) {
      const report = ctx.session.permissions?.()
      if (!report) {
        ctx.print("This session has no permission policy.")
        return
      }
      const modes: Record<string, string> = {
        auto: "runs everything without asking, except what rules and protected files say",
        edits: "changes files without asking; asks before shell commands",
        plan: "read-only: no file changes, no shell commands",
      }
      const where = report.modeSource === "default" ? "the default" : `from ${report.modeSource}`
      const lines = [
        `Mode: ${report.mode} (${where}) — ${modes[report.mode] ?? ""}`,
        "Shift+Tab cycles auto, edits and plan in the UI; --permission-mode and permissions.mode set it at start.",
        "",
      ]
      if (report.rules.length) {
        lines.push(
          `Command rules (${report.rules.length}; deny wins over ask, ask over allow):`,
          table(
            report.rules.map((r) => [
              r.decision,
              r.command.join(" "),
              `${r.scope} ${r.file}${r.reason ? ` — ${r.reason}` : ""}`,
            ]),
          ),
        )
      } else lines.push('No command rules. Add them to "permissions.rules" in settings.json.')
      lines.push(
        "",
        "Protected (writes and edits always ask, in every mode): .amira directories and Amira's user directory, .git (hooks, config), .gitmodules, core.hooksPath and your Git config.",
        "Shell commands can still change these files: they do not run in a sandbox yet.",
      )
      if (report.warnings.length) lines.push("", "Left out:", ...report.warnings.map((w) => `  ${w}`))
      ctx.print(lines.join("\n"))
    },
  }
}
