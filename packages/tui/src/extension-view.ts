import type { ViewDefinition, ViewLine } from "@amira/api"
import {
  type Component,
  type InputEvent,
  matchesKey,
  type RenderContext,
  ScrollView,
  type Theme,
  truncateToWidth,
} from "@amira/tui-kit"
import { renderToolLines } from "./diff-view.ts"

/** Where the TUI finds the view kinds extensions registered. */
export interface ViewSource {
  get(kind: string): ViewDefinition | undefined
}

export interface ExtensionViewerOptions {
  /** Titles of main-session dialogs waiting for an answer; shown as a banner. */
  waiting?: () => string[]
  now?: () => number
  /** Called when the user (or the view) asks to leave it. */
  onClose?: () => void
  /** Asks for a redraw, for key handlers that changed the data. */
  requestRender?: () => void
  /** Reports a view that threw, e.g. as an extension error; the view shows a line instead. */
  onError?: (error: string) => void
}

/**
 * A full-screen view an extension registered (ViewDefinition), over the data a command
 * opened it with: the title and header stay at the top, the body scrolls (ScrollView), and the
 * footer lists the view's own keys. Esc, q and Ctrl+C ask to close it. It only renders and
 * routes keys; the frontend opens it on a FullScreenRenderer and redraws it as events come.
 */
export class ExtensionViewer implements Component {
  readonly kind: string
  #view: ViewDefinition
  #data: unknown
  #opts: ExtensionViewerOptions
  #scroll: ScrollView
  #now: () => number
  /** The view does not follow its end: the first render puts it at the top. */
  #placed: boolean
  /** The last error of each part of the view, so one that keeps throwing is reported once. */
  #failed = new Map<string, string>()

  constructor(view: ViewDefinition, data: unknown, opts: ExtensionViewerOptions = {}) {
    this.kind = view.kind
    this.#view = view
    this.#data = data
    this.#opts = opts
    this.#now = opts.now ?? Date.now
    this.#placed = view.follow !== false
    this.#scroll = new ScrollView((width, ctx) => this.#body(width, ctx.theme))
  }

  /** Shows other data, e.g. when a command opens the same kind again. */
  show(data: unknown): void {
    this.#data = data
  }

  get scroll(): ScrollView {
    return this.#scroll
  }

  handleInput(e: InputEvent): boolean {
    if (matchesKey(e, "escape") || matchesKey(e, "q") || matchesKey(e, "c", { ctrl: true })) {
      this.#opts.onClose?.()
      return true
    }
    for (const k of this.#view.keys ?? []) {
      if (k.key.length !== 1 || k.key === "q" || !matchesKey(e, k.key)) continue
      this.#call(`key ${k.key}`, () =>
        k.run(this.#data, {
          close: () => this.#opts.onClose?.(),
          requestRender: () => this.#opts.requestRender?.(),
        }),
      )
      this.#opts.requestRender?.()
      return true
    }
    return this.#scroll.handleInput(e)
  }

  render(width: number, ctx: RenderContext): string[] {
    const { theme } = ctx
    const opts = { width, now: this.#now() }
    const head: string[] = []
    const title = this.#call("title", () => this.#view.title(this.#data)) ?? this.kind
    head.push(truncateToWidth(`${theme.accent("◆")} ${theme.text(oneLine(title))}`, width, "…"))
    const extra = this.#view.header
      ? (this.#call("header", () => this.#view.header?.(this.#data, opts)) ?? [])
      : []
    head.push(...renderToolLines(extra, theme, width))
    for (const t of this.#opts.waiting?.() ?? []) {
      head.push(theme.warning(truncateToWidth(`! Waiting for you: ${t} · Esc to answer`, width, "…")))
    }
    head.push(theme.muted("─".repeat(width)))
    this.#scroll.height = Math.max(1, ctx.rows - head.length - 1)
    let body = this.#scroll.render(width, ctx)
    if (!this.#placed) {
      // Content is known only after a render: then it can start at the top.
      this.#placed = true
      this.#scroll.scrollToTop()
      body = this.#scroll.render(width, ctx)
    }
    return [...head, ...body, this.#footer(theme, width)].slice(0, ctx.rows)
  }

  #body(width: number, theme: Theme): string[] {
    const lines: ViewLine[] = this.#call("render", () =>
      this.#view.render(this.#data, { width, now: this.#now() }),
    ) ?? [
      {
        kind: "error",
        text: `The ${this.kind} view failed: ${this.#failed.get("render") ?? "unknown error"}`,
      },
    ]
    return renderToolLines(lines, theme, width)
  }

  #footer(theme: Theme, width: number): string {
    const p = this.#scroll.position
    // Where the body is, when it does not fit.
    const where =
      p.total <= p.height
        ? []
        : [p.following ? "end" : `${p.top + 1}–${Math.min(p.total, p.top + p.height)} of ${p.total}`]
    const own = (this.#view.keys ?? []).map((k) => `${k.key} ${k.label}`)
    const keys = [...where, ...own, "↑↓ PgUp PgDn Home End scroll", "Esc back"].join(" · ")
    return theme.muted(truncateToWidth(keys, width, "…"))
  }

  /** Runs a part of the view's code; a throw is reported (once in a row) and gives undefined. */
  #call<T>(part: string, fn: () => T): T | undefined {
    try {
      const out = fn()
      this.#failed.delete(part)
      return out
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (this.#failed.get(part) !== message) this.#opts.onError?.(`${part} failed: ${message}`)
      this.#failed.set(part, message)
      return undefined
    }
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}
