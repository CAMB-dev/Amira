import { userMessage } from "@amira/ai"
import type { AnyEvent, Message, SubagentInfo, ToolCallBlock, ToolResultMessage } from "@amira/api"
import {
  type Component,
  type InputEvent,
  matchesKey,
  type RenderContext,
  ScrollView,
  type Theme,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { summarizeArgs, toolLines, userLines } from "./format.ts"

/** What the viewer reads its sub-agents from. */
export interface SubagentSource {
  /** This session's sub-agents, depth first; the viewer switches between them in this order. */
  subagents(): SubagentInfo[]
  /** A snapshot of one's conversation. */
  subagentMessages(id: string): readonly Message[] | undefined
}

export interface SubagentViewerOptions {
  source: SubagentSource
  /** Titles of main-session dialogs waiting for an answer; shown as a banner. */
  waiting?: () => string[]
  now?: () => number
  /** Called when the user asks to leave the viewer (Esc, q, Ctrl+C). */
  onClose?: () => void
}

function compactTokens(n: number): string {
  if (n < 1000) return String(n)
  return n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`
}

function elapsed(info: SubagentInfo, now: number): string {
  const ms = info.durationMs ?? (info.startedAt !== undefined ? now - info.startedAt : undefined)
  if (ms === undefined) return "queued"
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
}

function statusStyle(theme: Theme, info: SubagentInfo) {
  switch (info.status) {
    case "running":
      return theme.accent
    case "done":
      return theme.success
    case "error":
      return theme.error
    case "aborted":
      return theme.warning
    default:
      return theme.muted
  }
}

/** The one-line stats of a sub-agent: status, time, tokens and cost when known. */
export function subagentStats(theme: Theme, info: SubagentInfo, now: number): string {
  const u = info.usage
  const tokens = `${compactTokens(u.input + u.output + u.cacheRead + u.cacheWrite)} tok`
  const cost = u.cost !== undefined ? ` · $${u.cost.toFixed(4)}` : ""
  const timed = info.durationMs !== undefined || info.startedAt !== undefined
  const when = info.status === "queued" || !timed ? "" : ` · ${elapsed(info, now)}`
  return `${statusStyle(theme, info)(info.status)}${theme.muted(`${when} · ${tokens}${cost}`)}`
}

function blockText(content: Message["content"]): string {
  return content.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).join("\n")
}

function spawnCount(call: ToolCallBlock): number {
  const tasks = (call.args as { tasks?: unknown }).tasks
  return Array.isArray(tasks) ? tasks.length : 1
}

/**
 * A sub-agent's whole transcript for the full-screen viewer: the task, what it said, each
 * tool call with a one-line result preview (running ones marked, the sub-agents an agent
 * call started under it), and how it ended. Text is wrapped to `width`, nothing is cut.
 */
export function transcriptLines(
  theme: Theme,
  info: SubagentInfo,
  messages: readonly Message[],
  kids: SubagentInfo[],
  width: number,
  now: number,
): string[] {
  const out: string[] = []
  // A forked child starts with its parent's history; its own part starts at its task.
  const own = messages.slice(
    Math.max(
      0,
      messages.findLastIndex((m) => m.role === "user"),
    ),
  )
  const task = own[0]?.role === "user" ? blockText(own[0].content).trim() : info.task
  const first = own[0]?.role === "user" && task ? own[0] : userMessage(task || "(no task)")
  for (const l of userLines(theme, first)) out.push(...wrapText(l, width))
  out.push("")
  const results = new Map<string, ToolResultMessage>()
  for (const m of own) if (m.role === "toolResult") results.set(m.toolCallId, m)
  const rest = [...kids]
  const finished = info.status !== "running" && info.status !== "queued"
  const kidLine = (k: SubagentInfo, indent: string) =>
    truncateToWidth(
      `${indent}${theme.accent("◆")} ${k.role} ${theme.muted(k.id)} ${subagentStats(theme, k, now)} ${theme.muted(`· ${k.task.replace(/\s+/g, " ").trim()}`)}`,
      width,
      "…",
    )
  for (const m of own) {
    if (m.role !== "assistant") continue
    for (const b of m.content) {
      if (b.type === "text" && b.text.trim()) out.push(...wrapText(b.text.trim(), width), "")
      else if (b.type === "toolCall") {
        const r = results.get(b.id)
        if (r) out.push(...toolLines(theme, b.name, b.args, r, 0, width))
        else {
          const summary = summarizeArgs(b.args)
          out.push(
            truncateToWidth(
              `${theme.accent("●")} ${theme.accent(b.name)}${summary ? ` ${summary}` : ""}`,
              width,
              "…",
            ),
            `  ${theme.muted(`⎿ ${finished ? "(no result)" : "running…"}`)}`,
          )
        }
        if (b.name === "agent") for (const k of rest.splice(0, spawnCount(b))) out.push(kidLine(k, "  "))
        out.push("")
      }
    }
  }
  for (const k of rest) out.push(kidLine(k, ""))
  if (rest.length) out.push("")
  return out
}

/** Live state the snapshot does not have yet: the reply being streamed. */
interface Streaming {
  text: string
  thinking: boolean
}

/**
 * The full-screen view of sub-agents (M5): one sub-agent's transcript at a time, updated
 * live as its events arrive, scrollable and following the tail by default, with a header
 * (role, id, status, time, tokens) and ←/→ (or Tab) to switch between sub-agents. Esc, q or
 * Ctrl+C asks to close it. Dialogs of the main session waiting for an answer show as a
 * banner under the header, since only the main UI can answer them.
 *
 * It only renders and routes keys; the frontend opens it on a FullScreenRenderer and feeds
 * it the bus events. The pieces (transcriptLines, subagentStats, ScrollView) are meant to be
 * reused by a view of many agents at once.
 */
export class SubagentViewer implements Component {
  #source: SubagentSource
  #waiting: () => string[]
  #now: () => number
  #onClose: () => void
  #current: string
  #views = new Map<string, ScrollView>()
  #streams = new Map<string, Streaming>()
  /** Wrapped snapshot lines of the current sub-agent, until its state or the width changes. */
  #cache: { key: string; lines: string[] } | undefined
  /** The sub-agent shown and its state, as of the last render. */
  #shown: { info: SubagentInfo | undefined; list: SubagentInfo[] } = { info: undefined, list: [] }

  constructor(sessionId: string, opts: SubagentViewerOptions) {
    this.#current = sessionId
    this.#source = opts.source
    this.#waiting = opts.waiting ?? (() => [])
    this.#now = opts.now ?? Date.now
    this.#onClose = opts.onClose ?? (() => {})
  }

  /** The sub-agent shown. */
  get current(): string {
    return this.#current
  }

  show(sessionId: string): void {
    this.#current = sessionId
  }

  /** Scroll state of the sub-agent shown, for tests and callers that want to keep it. */
  get scroll(): ScrollView {
    return this.#view(this.#current)
  }

  /** Follows a bus event; true when the view may have changed. */
  handleEvent(e: AnyEvent): boolean {
    switch (e.type) {
      case "message.start":
        this.#streams.set(e.sessionId, { text: "", thinking: false })
        break
      case "message.delta": {
        const s = this.#streams.get(e.sessionId) ?? { text: "", thinking: false }
        if (e.data.kind === "text") {
          s.text += e.data.text
          s.thinking = false
        } else if (e.data.kind === "thinking") s.thinking = true
        this.#streams.set(e.sessionId, s)
        break
      }
      case "message.end":
      case "turn.end":
        // The reply is in the conversation now.
        this.#streams.delete(e.sessionId)
        break
      case "subagent.start":
      case "subagent.end":
      case "ui.request":
      case "ui.resolved":
        return true
    }
    return e.parentSessionId !== undefined
  }

  /** Handles a key; Esc, q and Ctrl+C call `onClose`. */
  handleInput(e: InputEvent): boolean {
    if (matchesKey(e, "escape") || matchesKey(e, "q") || matchesKey(e, "c", { ctrl: true })) {
      this.#onClose()
      return true
    }
    if (matchesKey(e, "right") || matchesKey(e, "tab", { shift: false })) return this.#switch(1)
    if (matchesKey(e, "left") || matchesKey(e, "tab", { shift: true })) return this.#switch(-1)
    return this.#view(this.#current).handleInput(e)
  }

  render(width: number, ctx: RenderContext): string[] {
    const { theme } = ctx
    const now = this.#now()
    const list = this.#source.subagents()
    const index = list.findIndex((s) => s.id === this.#current)
    const info = list[index]
    this.#shown = { info, list }
    const head: string[] = []
    if (info) {
      const pos = theme.muted(` ${index + 1}/${list.length}`)
      const title = `${theme.accent("◆")} ${theme.text(info.role)} ${theme.muted(info.id)} ${subagentStats(theme, info, now)}`
      const room = width - visibleWidth(pos)
      const fitted = truncateToWidth(title, Math.max(1, room), "…")
      head.push(fitted + " ".repeat(Math.max(0, room - visibleWidth(fitted))) + pos)
      head.push(theme.muted(truncateToWidth(`task: ${info.task.replace(/\s+/g, " ").trim()}`, width, "…")))
    } else {
      head.push(theme.warning(truncateToWidth(`No sub-agent ${this.#current} in this session.`, width, "…")))
    }
    for (const title of this.#waiting()) {
      head.push(theme.warning(truncateToWidth(`! Waiting for you: ${title} · Esc to answer`, width, "…")))
    }
    head.push(theme.muted("─".repeat(width)))
    const view = this.#view(this.#current)
    view.height = Math.max(1, ctx.rows - head.length - 1)
    const body = view.render(width, ctx)
    return [...head, ...body, this.#footer(theme, view, width)].slice(0, ctx.rows)
  }

  #lines(width: number, theme: Theme): string[] {
    const { info, list } = this.#shown
    if (!info) return []
    const now = this.#now()
    const messages = this.#source.subagentMessages(info.id) ?? []
    const kids = list.filter((s) => s.parentSessionId === info.id)
    const key = [
      info.id,
      width,
      messages.length,
      info.status,
      ...kids.map((k) => `${k.id}:${k.status}:${k.usage.output}`),
      // Kids' elapsed time moves while they run.
      kids.some((k) => k.status === "running") ? Math.floor(now / 1000) : 0,
    ].join("|")
    if (this.#cache?.key !== key) {
      this.#cache = { key, lines: transcriptLines(theme, info, messages, kids, width, now) }
    }
    const out = [...this.#cache.lines]
    const s = this.#streams.get(info.id)
    if (s?.text.trim()) out.push(...wrapText(s.text.trim(), width), "")
    if (info.status === "running" || info.status === "queued") {
      const what =
        info.status === "queued" ? "waiting for a free slot" : s?.thinking ? "thinking…" : "working…"
      out.push(theme.muted(`… ${what}`))
    } else if (info.error && info.status !== "done") out.push(theme.error(`✗ ${info.error}`))
    else out.push(theme.muted(`── ${info.status} ──`))
    return out
  }

  #footer(theme: Theme, view: ScrollView, width: number): string {
    const p = view.position
    const where = p.following
      ? "following"
      : `${Math.min(p.total, p.top + 1)}–${Math.min(p.total, p.top + p.height)} of ${p.total}`
    const keys = "↑↓ PgUp PgDn Home End scroll · ←→ switch · Esc back"
    return theme.muted(truncateToWidth(`${where} · ${keys}`, width, "…"))
  }

  #view(id: string): ScrollView {
    let v = this.#views.get(id)
    if (!v) {
      v = new ScrollView((width, ctx) => this.#lines(width, ctx.theme))
      this.#views.set(id, v)
    }
    return v
  }

  #switch(step: number): true {
    const list = this.#shown.list.length ? this.#shown.list : this.#source.subagents()
    if (!list.length) return true
    const i = list.findIndex((s) => s.id === this.#current)
    this.#current = list[(i + step + list.length) % list.length]!.id
    return true
  }
}
