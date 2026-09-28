import type { CommandDefinition, ToolDetailLevel } from "@amira/api"

/** The tool output levels, in the order Ctrl+O cycles through them from the default. */
export const DETAIL_LEVELS: readonly ToolDetailLevel[] = ["summary", "full", "collapsed"]

const DESCRIPTIONS: Record<ToolDetailLevel, string> = {
  collapsed: "one result line per tool call",
  summary: "failures and diffs, cut short (default)",
  full: "everything the tools returned",
}

export function nextDetail(level: ToolDetailLevel): ToolDetailLevel {
  return DETAIL_LEVELS[(DETAIL_LEVELS.indexOf(level) + 1) % DETAIL_LEVELS.length]!
}

/**
 * /verbose: how much of each finished tool call the TUI commits from now on. Without an
 * argument it moves to the next level, like Ctrl+O. `set` returns the line to print.
 */
export function detailCommand(
  get: () => ToolDetailLevel,
  set: (level: ToolDetailLevel) => string,
): CommandDefinition {
  return {
    name: "verbose",
    description: "Show more or less of later tool output (collapsed, summary, full)",
    args: {
      hint: "[collapsed|summary|full]",
      complete: () => DETAIL_LEVELS.map((value) => ({ value, description: DESCRIPTIONS[value] })),
    },
    run(args, ctx) {
      if (ctx.frontend !== "tui") return ctx.print("/verbose only changes the terminal UI.", "warning")
      const level = args.trim().toLowerCase()
      if (!level) return ctx.print(set(nextDetail(get())))
      if (!(DETAIL_LEVELS as readonly string[]).includes(level)) {
        return ctx.print(`Unknown level "${args.trim()}"; use collapsed, summary or full.`, "error")
      }
      ctx.print(set(level as ToolDetailLevel))
    },
  }
}
