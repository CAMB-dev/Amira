import { clip, defineExtension } from "@amira/api"

const clean = (text: string, width: number) => clip(text.replace(/\s+/g, " ").trim(), width)

/** Terminal status policy; the frontend owns all terminal sequences and restoration. */
export default defineExtension((api) => {
  let sessionId: string | undefined
  let folder = ""
  let sessionTitle: string | undefined
  let working = false
  let waiting = false
  let focused: boolean | undefined

  const sync = () => {
    const name = clean(sessionTitle || folder, 64)
    const base = `Amira · ${name}`
    api.terminal.setTitle(clip(working ? `● ${base}` : base, 128))
    api.terminal.setProgress(waiting ? "paused" : working ? "indeterminate" : "none")
  }
  const ring = (question = false) => {
    // The frontend knows dialog kinds and deduplicates alerts for each continuous wait.
    if (focused === false || (focused === undefined && question)) api.terminal.bell()
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
    working = false
    sync()
  })
  api.on("session.title", (e) => {
    if (e.sessionId !== sessionId) return
    sessionTitle = e.data.title.trim() || undefined
    sync()
  })
  api.on("turn.start", (e) => {
    if (e.sessionId !== sessionId) return
    working = true
    sync()
  })
  api.on("turn.end", (e) => {
    if (e.sessionId !== sessionId) return
    working = false
    sync()
    if (e.data.reason !== "aborted") ring()
  })
  api.on("ui.focus", (e) => {
    focused = e.data.focused
    if (!focused && waiting) ring(true)
  })
  api.on("ui.waiting", (e) => {
    waiting = e.data.pending > 0
    sync()
    if (waiting && e.data.change === "opened") ring(true)
  })
})
