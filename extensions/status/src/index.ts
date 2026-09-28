import path from "node:path"
import { defineExtension, type SessionStatus } from "@amira/api"

/** Compact token counts: 999, 1.2k, 46k, 2.5M. Rounds before picking the unit. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  if (Number(k.toFixed(1)) < 10) return `${k.toFixed(1)}k`
  if (Math.round(k) < 1000) return `${Math.round(k)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** "12.3k/128k (10%)", or just "12.3k" when the window is unknown. */
export function formatContext(used: number, window: number | undefined): string {
  if (!window) return formatTokens(used)
  const pct = Math.min(999, Math.round((used / window) * 100))
  return `${formatTokens(used)}/${formatTokens(window)} (${pct}%)`
}

/**
 * Output tokens per second of one reply, timed from its first streamed piece to its end.
 * Undefined when the reply was too short to time meaningfully.
 */
export function tokensPerSecond(
  outputTokens: number,
  firstDeltaAt: number,
  endAt: number,
): number | undefined {
  const seconds = (endAt - firstDeltaAt) / 1000
  if (outputTokens <= 0 || seconds < 0.2) return undefined
  return outputTokens / seconds
}

/** Share of prompt tokens served from the provider's cache; undefined before any prompt tokens. */
export function cacheHitRate(input: number, cacheRead: number, cacheWrite: number): number | undefined {
  const prompt = input + cacheRead + cacheWrite
  return prompt > 0 ? cacheRead / prompt : undefined
}

/**
 * The default status bar: model, activity, context use against the model's window,
 * output tokens, the speed of the last reply, and the git branch or folder.
 */
export default defineExtension((api) => {
  let model = ""
  let status: SessionStatus = "idle"
  let statusReason = ""
  let context = 0
  let contextWindow: number | undefined
  let output = 0
  let promptInput = 0
  let promptCacheRead = 0
  let promptCacheWrite = 0
  let firstDeltaAt: number | undefined
  let tps: number | undefined
  let place = ""

  api.on("session.start", (e) => {
    model = `${e.data.model.provider}/${e.data.model.model}`
    if (e.data.reason !== "resume") {
      context = 0
      output = 0
      promptInput = 0
      promptCacheRead = 0
      promptCacheWrite = 0
      tps = undefined
      status = "idle"
      statusReason = ""
    }
    place ||= path.basename(e.data.cwd)
    api.requestRender()
  })
  api.on("workspace.changed", (e) => {
    const folder = path.basename(e.data.repoRoot ?? e.data.cwd)
    const ref = e.data.branch ?? (e.data.head ? `@${e.data.head}` : "")
    place = ref ? `${folder} ⎇ ${ref}${e.data.isWorktree ? " (worktree)" : ""}` : folder
    api.requestRender()
  })
  api.on("message.start", (e) => {
    model = `${e.data.model.provider}/${e.data.model.model}`
    if (e.data.contextWindow) contextWindow = e.data.contextWindow
    firstDeltaAt = undefined
  })
  api.on("message.delta", (e) => {
    firstDeltaAt ??= e.ts
  })
  api.on("message.end", (e) => {
    const u = e.data.message.usage
    if (!u) return
    context = u.input + u.cacheRead + u.cacheWrite + u.output
    output += u.output
    promptInput += u.input
    promptCacheRead += u.cacheRead
    promptCacheWrite += u.cacheWrite
    if (firstDeltaAt !== undefined) tps = tokensPerSecond(u.output, firstDeltaAt, e.ts) ?? tps
    api.requestRender()
  })
  api.on("status.changed", (e) => {
    status = e.data.status
    statusReason = e.data.reason ?? ""
    api.requestRender()
  })

  api.registerStatusItem({ id: "model", align: "left", order: 0, tone: "accent", text: () => model })
  api.registerStatusItem({
    id: "activity",
    align: "left",
    order: 10,
    text: () =>
      status === "idle" ? "" : status === "blocked" && statusReason ? `waiting: ${statusReason}` : status,
  })
  api.registerStatusItem({
    id: "tokens",
    align: "right",
    order: 0,
    tone: "muted",
    text: () =>
      context || output ? `ctx ${formatContext(context, contextWindow)} · out ${formatTokens(output)}` : "",
  })
  api.registerStatusItem({
    id: "cache",
    align: "right",
    order: 3,
    tone: "muted",
    text: () => {
      const rate = cacheHitRate(promptInput, promptCacheRead, promptCacheWrite)
      return rate === undefined ? "" : `cache ${Math.round(rate * 100)}%`
    },
  })
  api.registerStatusItem({
    id: "speed",
    align: "right",
    order: 5,
    tone: "muted",
    text: () => (tps === undefined ? "" : `${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tok/s`),
  })
  api.registerStatusItem({ id: "place", align: "right", order: 10, tone: "muted", text: () => place })
})
