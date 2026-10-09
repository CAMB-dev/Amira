import path from "node:path"
import { defineExtension, formatTokens, hasUnpricedSearch, type StatusTone } from "@amira/api"

export { formatTokens }

/** "12.3k/128k (10%)", or just "12.3k" when the window is unknown. */
export function formatContext(used: number, window: number | undefined): string {
  if (!window) return formatTokens(used)
  const pct = Math.min(999, Math.round((used / window) * 100))
  return `${formatTokens(used)}/${formatTokens(window)} (${pct}%)`
}

/** "$1.25", "$0.012", "$0.0004"; tinier amounts show as "<$0.0001". */
export function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01 || usd === 0) return `$${usd.toFixed(3)}`
  return usd < 0.00005 ? "<$0.0001" : `$${usd.toFixed(4)}`
}

/** How the context use reads: a warning above 70% of the window, an error above 90%. */
export function contextTone(used: number, window: number | undefined): StatusTone {
  if (!window) return "muted"
  const share = used / window
  return share > 0.9 ? "error" : share > 0.7 ? "warning" : "muted"
}

/**
 * Where the session works, as the status reads it: the branch, "*" when the working tree has
 * changes not committed yet, "@<hash>" for a detached HEAD; the folder outside a repository.
 */
export function placeLabel(ws: {
  cwd: string
  repoRoot?: string
  branch?: string
  head?: string
  isWorktree?: boolean
  dirty?: boolean
}): string {
  const ref = ws.branch ?? (ws.head ? `@${ws.head}` : "")
  if (!ref) return path.basename(ws.repoRoot ?? ws.cwd)
  return `${ref}${ws.dirty ? "*" : ""}${ws.isWorktree ? " (worktree)" : ""}`
}

/**
 * The default status (drawn in the input box's border): the model, the context use against
 * its window, the cost of the whole agent tree, and the git branch. They keep to the front
 * (negative orders) and to the bar when it narrows (priorities 10 to 40, the model last to
 * go), so other extensions' items follow them and give way first. The activity and running
 * sub-agents are left to the activity line and the transcript; output tokens and the cache
 * hit rate to /status. The commands extension adds a lower-priority live token-speed item.
 */
export default defineExtension((api) => {
  let model = ""
  let context = 0
  let contextWindow: number | undefined
  let cost: number | undefined
  let unpricedSearch = false
  /** The agent tree's own total, which also counts calls made outside a turn (approvals). */
  let treeCost: number | undefined
  let place = ""

  // Sub-agents share the bus (their events carry parentSessionId). The bar describes the
  // top-level session, except the cost, which is the whole tree's (D37).
  const own = (e: { parentSessionId?: string }) => e.parentSessionId === undefined
  const modelName = (m: { provider: string; model: string }) => (m.provider ? m.model : "(no model)")

  api.on("session.start", (e) => {
    if (!own(e)) return
    model = modelName(e.data.model)
    // Another session: its own context (a resumed one says where it was), and a cost that
    // counts from here.
    context = e.data.contextTokens ?? 0
    if (e.data.contextWindow) contextWindow = e.data.contextWindow
    cost = undefined
    unpricedSearch = false
    treeCost = undefined
    place ||= path.basename(e.data.cwd)
    api.requestRender()
  })
  api.on("workspace.changed", (e) => {
    place = placeLabel(e.data)
    api.requestRender()
  })
  api.on("message.start", (e) => {
    if (!own(e)) return
    model = modelName(e.data.model)
    if (e.data.contextWindow) contextWindow = e.data.contextWindow
  })
  api.on("model.changed", (e) => {
    if (!own(e)) return
    model = modelName(e.data.to)
    api.requestRender()
  })
  api.on("thinking.changed", (e) => {
    if (!own(e)) return
    api.requestRender()
  })
  api.on("message.end", (e) => {
    const u = e.data.message.usage
    if (!u) return
    unpricedSearch ||= hasUnpricedSearch(e.data.message)
    if (u.cost !== undefined) cost = (cost ?? 0) + u.cost
    if (!own(e)) return api.requestRender()
    // An interrupted reply may end with no usage counted; the context is still what it was.
    const tokens = u.input + u.cacheRead + u.cacheWrite + u.output
    if (tokens > 0) context = tokens
    api.requestRender()
  })
  api.on("budget.update", (e) => {
    if (e.data.costUsd === undefined) return
    treeCost = e.data.costUsd
    api.requestRender()
  })

  api.registerStatusItem({
    id: "model",
    align: "left",
    order: -40,
    priority: 40,
    tone: "accent",
    text: () => {
      const thinking = api.session()?.info().thinking
      return model && thinking ? `${model} (${thinking})` : model
    },
  })
  api.registerStatusItem({
    id: "context",
    align: "right",
    order: -30,
    priority: 30,
    tone: () => contextTone(context, contextWindow),
    text: () => (context ? `ctx ${formatContext(context, contextWindow)}` : ""),
  })
  api.registerStatusItem({
    id: "cost",
    align: "right",
    order: -20,
    priority: 20,
    tone: "muted",
    text: () => {
      if (unpricedSearch) return "cost unknown"
      const total = treeCost ?? cost
      return total === undefined ? "" : formatCost(total)
    },
  })
  api.registerStatusItem({
    id: "place",
    align: "right",
    order: -10,
    priority: 10,
    tone: "muted",
    text: () => place,
  })
})
