import type { CommandDefinition } from "@amira/api"
import { contextReport, table } from "./format.ts"

/** What each /prune scope deletes. */
const PRUNE_SCOPES = {
  unused: "artifacts nothing mentions",
  inactive: "also ones only compacted or rewound history mentions",
  all: "every artifact of this session",
}

/** "512 B", "24 KB", "1.2 MB": human-readable artifact sizes. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
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
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const yes = parts.at(-1) === "--yes"
      const scope = yes ? parts.slice(0, -1).join(" ") : args.trim()
      if (scope || yes) {
        if (!(scope in PRUNE_SCOPES) || parts.length > (yes ? 2 : 1))
          throw new Error(`Usage: /prune [${Object.keys(PRUNE_SCOPES).join("|")}] [--yes]`)
        if (scope === "all" && !yes && ctx.frontend !== "print") {
          const u = artifacts.usage()
          if (u.active + u.inactive + u.unused > 0) {
            const detail =
              u.active > 0
                ? `${u.active} active ${u.active === 1 ? "artifact is" : "artifacts are"} still referenced in the current context. Reading one afterward says it was pruned.`
                : "Every saved artifact of this session will be deleted."
            const confirmed = await ctx.ui.confirm("Delete all artifacts?", detail, {
              signal: ctx.signal,
              tone: "warning",
            })
            if (!confirmed) {
              ctx.print("Prune cancelled.")
              return
            }
          }
        }
        const r = await artifacts.prune(scope as keyof typeof PRUNE_SCOPES)
        ctx.print(
          r.removed
            ? `Deleted ${r.removed} ${r.removed === 1 ? "artifact" : "artifacts"} (${formatSize(r.bytes)}). Reading one now says it was pruned.`
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
                ["Group", "Active", "Inactive", "Unused", "Pruned", "Size"],
                ...u.groups.map((g) => [
                  `${g.label}${g.protected ? " (protected)" : ""}`,
                  String(g.active),
                  String(g.inactive),
                  String(g.unused),
                  String(g.pruned),
                  formatSize(g.bytes),
                ]),
              ]),
            ]
          : []
      ctx.print(
        [
          `Artifacts: ${formatSize(u.bytes)} of the ${formatSize(u.quotaBytes)} quota in ${u.dir}`,
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
      ctx.print(
        contextReport(
          await ctx.session.preview(),
          info.contextWindow,
          info.contextTokens,
          info.contextWindowSource,
        ),
      )
    },
  }
}
