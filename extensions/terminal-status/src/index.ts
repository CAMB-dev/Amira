import { clip, defineExtension } from "@amira/api"

const clean = (text: string, width: number) => clip(text.replace(/\s+/g, " ").trim(), width)

/** Terminal status policy; the frontend owns all terminal sequences and restoration. */
export default defineExtension((api) => {
  let sessionId: string | undefined
  let folder = ""
  let sessionTitle: string | undefined
  let branch: string | undefined
  let working = false
  let waiting = false
  let focused: boolean | undefined
  let turnStartedAt: number | undefined

  const sync = () => {
    const name = sessionTitle ? `${clean(folder, 48)} · ${clean(sessionTitle, 64)}` : clean(folder, 48)
    const base = clip(`Amira · ${name}${branch ? ` ⎇ ${clean(branch, 40)}` : ""}`, 128)
    api.terminal.setTitle(clip(working ? `● ${base}` : base, 128))
    api.terminal.setProgress(waiting ? "paused" : working ? "indeterminate" : "none")
  }
  const ring = (ts: number, hidden = false) => {
    const long = turnStartedAt !== undefined && ts - turnStartedAt >= 15_000
    if (hidden || focused === false || (focused === undefined && long)) api.terminal.bell()
  }

  api.on("session.start", (e) => {
    if (e.parentSessionId !== undefined) return
    sessionId = e.sessionId
    folder =
      e.data.cwd
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() || e.data.cwd
    sessionTitle = e.data.title?.trim() || undefined
    branch = undefined
    working = false
    turnStartedAt = undefined
    sync()
  })
  api.on("session.title", (e) => {
    if (e.sessionId !== sessionId) return
    sessionTitle = e.data.title.trim() || undefined
    sync()
  })
  api.on("workspace.changed", (e) => {
    if (e.sessionId !== sessionId) return
    branch = e.data.branch
    sync()
  })
  api.on("turn.start", (e) => {
    if (e.sessionId !== sessionId) return
    working = true
    turnStartedAt = e.ts
    sync()
  })
  api.on("turn.end", (e) => {
    if (e.sessionId !== sessionId) return
    working = false
    sync()
    if (e.data.reason !== "aborted") ring(e.ts)
    turnStartedAt = undefined
  })
  api.on("ui.focus", (e) => {
    focused = e.data.focused
  })
  api.on("ui.waiting", (e) => {
    const wasWaiting = waiting
    waiting = e.data.pending > 0
    sync()
    if (waiting && e.data.change === "opened" && (!wasWaiting || e.data.hidden)) ring(e.ts, e.data.hidden)
  })
})
