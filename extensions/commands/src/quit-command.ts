import { type CommandDefinition, plural } from "@amira/api"

const ACTIVE_SUBAGENT_STATES = new Set(["running", "queued", "paused"])

export function quitCommand(): CommandDefinition {
  return {
    name: "quit",
    aliases: ["exit", "q"],
    description: "Leave Amira",
    async run(_args, ctx) {
      if (ctx.frontend === "tui") {
        const busy = ctx.session.info().busy
        const activeSubagents = ctx.session
          .subagents()
          .filter((s) => ACTIVE_SUBAGENT_STATES.has(s.status)).length
        if (busy || activeSubagents > 0) {
          const parts = [
            ...(busy ? ["a turn"] : []),
            ...(activeSubagents > 0 ? [plural(activeSubagents, "sub-agent")] : []),
          ]
          const ok = await ctx.ui.confirm(
            "Quit Amira?",
            `${parts.join(" and ")} ${busy && activeSubagents === 0 ? "is" : "are"} still running and will be stopped.`,
            { signal: ctx.signal, tone: "warning" },
          )
          if (!ok) return
        }
      }
      ctx.quit()
    },
  }
}
