import type { CommandDefinition } from "@amira/api"
import { contextReport, table } from "./format.ts"

/** What each /prune scope deletes. */
const PRUNE_SCOPES = {
  unused: "artifacts nothing mentions",
  inactive: "also ones only compacted or rewound history mentions",
  all: "every artifact of this session",
}

/** "1.2 MB": artifact sizes. */
function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

export function compactCommand(): CommandDefinition {
  return {
    name: "compact",
    description: "Summarize older messages now to free context",
    args: { hint: "[instructions]" },
    // Frontends show the outcome from compact.end and compact.failed, like an automatic one.
    async run(args, ctx) {
      await ctx.session.compact(args || undefined)
    },
  }
}

export function pruneCommand(): CommandDefinition {
  return {
    name: "prune",
    description: "Show or delete this session's saved tool outputs (artifacts)",
    args: {
      hint: "[unused|inactive|all]",
      complete: () => Object.entries(PRUNE_SCOPES).map(([value, description]) => ({ value, description })),
    },
    async run(args, ctx) {
      const artifacts = ctx.session.artifacts
      if (!artifacts) throw new Error("this session keeps no artifacts")
      const scope = args.trim()
      if (scope) {
        if (!(scope in PRUNE_SCOPES))
          throw new Error(`usage: /prune [${Object.keys(PRUNE_SCOPES).join("|")}]`)
        const r = await artifacts.prune(scope as keyof typeof PRUNE_SCOPES)
        ctx.print(
          r.removed
            ? `Deleted ${r.removed} ${r.removed === 1 ? "artifact" : "artifacts"} (${formatMb(r.bytes)}). Reading one now says it was pruned.`
            : "Nothing to delete.",
        )
        return
      }
      const u = artifacts.usage()
      const groups =
        u.groups && u.groups.length > 1
          ? [
              "Groups:",
              table([
                ["Group", "Active", "Inactive", "Unused", "Pruned", "Bytes"],
                ...u.groups.map((g) => [
                  `${g.label}${g.protected ? " (protected)" : ""}`,
                  String(g.active),
                  String(g.inactive),
                  String(g.unused),
                  String(g.pruned),
                  formatMb(g.bytes),
                ]),
              ]),
            ]
          : []
      ctx.print(
        [
          `Artifacts: ${formatMb(u.bytes)} of the ${formatMb(u.quotaBytes)} quota in ${u.dir}`,
          table([
            ["Active", `${u.active} (mentioned in the context the model sees)`],
            ["Inactive", `${u.inactive} (only in compacted or rewound history, or a sub-agent's)`],
            ["Unused", `${u.unused} (mentioned nowhere)`],
            ...(u.pruned ? ([["Pruned", String(u.pruned)]] as [string, string][]) : []),
          ]),
          ...groups,
          "/prune unused deletes the unused ones, /prune inactive those and the inactive ones, /prune all every one.",
        ].join("\n"),
      )
    },
  }
}

export function contextCommand(): CommandDefinition {
  return {
    name: "context",
    description: "Show what fills the context window",
    async run(_args, ctx) {
      const info = ctx.session.info()
      ctx.print(contextReport(await ctx.session.preview(), info.contextWindow, info.contextTokens))
    },
  }
}
