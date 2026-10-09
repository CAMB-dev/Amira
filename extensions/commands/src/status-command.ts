import {
  type CommandDefinition,
  type EventMap,
  type ExtensionAPI,
  hasUnpricedSearch,
  modelLabel,
} from "@amira/api"
import { cacheHitRate, costByModel, formatCost, formatTokens, table, windowLabel } from "./format.ts"
import { trackSpeed } from "./status-speed.ts"

/**
 * Creates /status and installs the event tracking it needs. Tracking is installed when this
 * factory is called so the extension's registration order stays the same as the original.
 */
export function statusCommand(api: ExtensionAPI): CommandDefinition {
  // Git facts per session, for /status; hosts without a workspace provider emit no facts.
  const workspace = new Map<string, EventMap["workspace.changed"]>()
  const waiting = new Set<() => void>()
  api.on("workspace.changed", (e) => {
    workspace.set(e.sessionId, e.data)
    for (const wake of waiting) wake()
  })
  /** Wait briefly for the initial facts, with a deadline even when no provider is loaded. */
  const workspaceOf = async (sessionId: string, signal: AbortSignal) => {
    const deadline = Date.now() + 2000
    while (!workspace.has(sessionId) && Date.now() < deadline && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          waiting.delete(wake)
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(wake, deadline - Date.now())
        waiting.add(wake)
      })
    }
    return workspace.get(sessionId)
  }

  const speed = trackSpeed(api)

  return {
    name: "status",
    description: "Show the model, session, context use, output, cache, speed, cost and workspace",
    async run(_args, ctx) {
      const info = ctx.session.info()
      const ws = await workspaceOf(info.id, ctx.signal)
      const messages = ctx.session.replies()
      const rows = costByModel(messages)
      const provider = ctx.session.providers().find((p) => p.id === info.model.provider)
      const git = !ws
        ? "unknown"
        : ws.repoRoot
          ? `${ws.branch ?? (ws.head ? `detached at ${ws.head.slice(0, 7)}` : "no branch")}${ws.isWorktree ? " (worktree)" : ""} in ${ws.repoRoot}${ws.dirty ? ", with uncommitted changes" : ""}`
          : "not a git repository"
      // This session's own replies, and with its sub-agents' (the status bar shows the latter,
      // as spent since this run started). Both count earlier runs of a resumed session.
      // Compactions (the server's, or summaries the model wrote) count too, and are named.
      const compactions = ctx.session.compactions?.() ?? []
      const compacted = compactions.filter((c) => c.usage.cost !== undefined)
      const compaction = compacted.length ? compacted.reduce((n, c) => n + (c.usage.cost ?? 0), 0) : undefined
      const priced = rows.filter((r) => r.cost !== undefined)
      const replies = priced.length ? priced.reduce((n, r) => n + (r.cost ?? 0), 0) : undefined
      const side = (ctx.session.sideRequests?.() ?? []).reduce((n, c) => n + (c.usage.cost ?? 0), 0)
      const own =
        replies !== undefined || compaction !== undefined || side
          ? (replies ?? 0) + (compaction ?? 0) + side
          : undefined
      const subagents = ctx.session.subagents()
      const subs = subagents.filter((s) => s.usage.cost !== undefined)
      const withSubs = subs.length
        ? (own ?? 0) + subs.reduce((n, s) => n + (s.usage.cost ?? 0), 0)
        : undefined
      const ofWhich = compaction !== undefined ? `; of which compaction ${formatCost(compaction)}` : ""
      const unpricedSearch =
        messages.some(hasUnpricedSearch) ||
        [...compactions, ...subagents].some((c) => hasUnpricedSearch({ content: [], usage: c.usage }))
      const cost = unpricedSearch
        ? "unknown (search cost unavailable)"
        : withSubs !== undefined
          ? `${formatCost(withSubs)} with sub-agents${own !== undefined && formatCost(own) !== formatCost(withSubs) ? `; this session alone ${formatCost(own)}` : ""}${ofWhich}`
          : own !== undefined
            ? `${formatCost(own)} (this session; no sub-agents)${ofWhich}`
            : "unknown"
      const usage = rows.reduce(
        (t, r) => ({
          input: t.input + r.usage.input,
          output: t.output + r.usage.output,
          cacheRead: t.cacheRead + r.usage.cacheRead,
          cacheWrite: t.cacheWrite + r.usage.cacheWrite,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      )
      const cacheRate = cacheHitRate(usage.input, usage.cacheRead, usage.cacheWrite)
      const context =
        info.contextTokens !== undefined
          ? `${formatTokens(info.contextTokens)} of ${formatTokens(info.contextWindow)} tokens (${Math.round((info.contextTokens / info.contextWindow) * 100)}%)`
          : "nothing sent yet"
      ctx.print(
        table([
          ["Model", modelLabel(info.model)],
          ...(info.thinking ? [["Thinking", info.thinking]] : []),
          [
            "Provider",
            provider
              ? `${provider.id} (${provider.dialect}, ${provider.baseUrl})`
              : info.model.provider || "(none; add one with /provider add, pick a model with /model)",
          ],
          ["Session", `${info.id}${info.busy ? " (turn running)" : ""}`],
          ...(info.title ? [["Title", info.title]] : []),
          ...(info.file ? [["Session file", info.file]] : []),
          ["Context", info.model.provider ? context : "no model yet"],
          ...(info.model.provider
            ? [["Window", windowLabel(info.contextWindow, info.contextWindowSource)]]
            : []),
          ["Output", `${formatTokens(usage.output)} tokens written by this session's replies`],
          [
            "Cache",
            cacheRate === undefined
              ? "nothing sent yet"
              : `${Math.round(cacheRate * 100)}% of this session's prompt tokens read from the cache`,
          ],
          ...speed(info.id),
          ["Cost", cost],
          ["Shell", info.shell],
          ...(info.permissions
            ? [
                [
                  "Permissions",
                  `${info.permissions.mode} mode; ${info.permissions.rules} command ${info.permissions.rules === 1 ? "rule" : "rules"} (/permissions lists them)`,
                ],
              ]
            : []),
          ["Directory", info.cwd],
          ["Git", git],
        ]),
      )
    },
  }
}
