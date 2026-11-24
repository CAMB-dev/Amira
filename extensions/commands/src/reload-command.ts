import { type CommandDefinition, plural, type ReloadReport } from "@amira/api"

/** "Reloaded 9 extensions · loaded workflow · 1 failed: x": what /reload changed. */
export function reloadSummary(r: ReloadReport, separator = "·"): string {
  const parts = [`Reloaded ${plural(r.extensions, "extension")}`]
  if (r.loaded.length) parts.push(`new: ${r.loaded.join(", ")}`)
  if (r.unloaded.length) parts.push(`gone: ${r.unloaded.join(", ")}`)
  if (r.skillsAdded) parts.push(`${r.skillsAdded} new ${r.skillsAdded === 1 ? "skill" : "skills"}`)
  if (r.skillsRemoved) parts.push(`${plural(r.skillsRemoved, "skill")} gone`)
  if (r.failed.length) parts.push(`${r.failed.length} failed: ${r.failed.join(", ")}`)
  if (parts.length === 1) parts.push("nothing changed")
  return parts.join(` ${separator} `)
}

export function reloadCommand(running: () => boolean): CommandDefinition {
  return {
    name: "reload",
    description: "Reload every extension",
    async run(_args, ctx) {
      if (running()) throw new Error("Extension management is running; reload after it ends.")
      const report = await ctx.session.reloadExtensions()
      const sep = ctx.glyphs?.().separator ?? "·"
      ctx.print(
        report ? reloadSummary(report, sep) : "Reloaded extensions.",
        report?.failed.length ? "warning" : "info",
      )
    },
  }
}
