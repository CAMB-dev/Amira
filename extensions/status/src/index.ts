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

/** The default status bar: model, activity, context size and output tokens, git branch or folder. */
export default defineExtension((api) => {
  let model = ""
  let status: SessionStatus = "idle"
  let statusReason = ""
  let context = 0
  let output = 0
  let place = ""

  api.on("session.start", (e) => {
    model = `${e.data.model.provider}/${e.data.model.model}`
    if (e.data.reason !== "resume") {
      context = 0
      output = 0
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
  })
  api.on("message.end", (e) => {
    const u = e.data.message.usage
    if (!u) return
    context = u.input + u.cacheRead + u.cacheWrite + u.output
    output += u.output
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
    text: () => (context || output ? `ctx ${formatTokens(context)} · out ${formatTokens(output)}` : ""),
  })
  api.registerStatusItem({ id: "place", align: "right", order: 10, tone: "muted", text: () => place })
})
