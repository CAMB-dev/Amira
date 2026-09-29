import type { ToolLine, ViewControl, ViewDefinition, ViewLine } from "@amira/api"
import {
  type Component,
  type InputEvent,
  isSubmitKey,
  LineInput,
  matchesKey,
  type RenderContext,
  ScrollView,
  type Theme,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { renderToolLines, terminalText } from "./diff-view.ts"
import { glyphs } from "./glyphs.ts"
import { fitHint } from "./hint.ts"
import { scrollPosition, waitingLine } from "./subagent-view.ts"

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

/** Lines of text that wrap to the width; the rest (code, diffs) are cut, as tool output is. */
const WRAPPED: ReadonlySet<ToolLine["kind"]> = new Set([
  "text",
  "muted",
  "accent",
  "success",
  "warning",
  "error",
])

/**
 * Where a wrapped line's later rows start: past its indent and a leading marker such as "✗ ",
 * "● ", "- " or "12. ", so they hang under its text.
 */
const HANG = /^(\s*)((?:[^\p{L}\p{N}\s]{1,2}|\d{1,3}[.)])\s+)?/u

/**
 * View lines fitted to `width`: text lines wrapped, their later rows hanging under their text,
 * code and diff lines as they are (renderToolLines cuts them).
 */
export function wrapViewLines(lines: readonly ViewLine[], width: number): ViewLine[] {
  const out: ViewLine[] = []
  for (const l of lines) {
    const text = terminalText(l.text)
    if (!WRAPPED.has(l.kind) || l.lineNo !== undefined || visibleWidth(text) <= width) {
      out.push(l)
      continue
    }
    const m = HANG.exec(text)!
    let hang = visibleWidth(m[0])
    // A marker that leaves too little room hangs nothing.
    if (width - hang < 10) hang = 0
    const rest = text.slice(m[0].length)
    const rows = hang ? wrapText(rest, width - hang) : wrapText(text, width)
    for (const [i, r] of rows.entries()) {
      out.push({ ...l, text: hang ? (i === 0 ? m[0] + r : " ".repeat(hang) + r) : r })
    }
  }
  return out
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
  /** A line of text a key handler asked for (ViewControl.prompt), while it is open. */
  #prompt: { title: string; input: LineInput; resolve: (text: string | undefined) => void } | undefined
  /** A question a key handler asked to confirm (ViewControl.confirm), until the next key answers. */
  #confirm: { text: string; resolve: (yes: boolean) => void } | undefined

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
    // A prompt asked about the data shown before is cancelled, not answered for the new one.
    if (data !== this.#data) {
      this.#answer(undefined)
      this.#confirmed(false)
    }
    this.#data = data
  }

  get scroll(): ScrollView {
    return this.#scroll
  }

  handleInput(e: InputEvent): boolean {
    if (this.#confirm) {
      // y confirms; any other key says no.
      this.#confirmed(matchesKey(e, "y"))
      this.#opts.requestRender?.()
      return true
    }
    const asking = this.#prompt
    if (asking) {
      if (matchesKey(e, "escape") || matchesKey(e, "c", { ctrl: true })) this.#answer(undefined)
      else if (isSubmitKey(e)) this.#answer(asking.input.value)
      else asking.input.handleInput(e)
      this.#opts.requestRender?.()
      return true
    }
    if (matchesKey(e, "escape") || matchesKey(e, "q") || matchesKey(e, "c", { ctrl: true })) {
      this.#opts.onClose?.()
      return true
    }
    for (const k of this.#view.keys ?? []) {
      if (k.key.length !== 1 || k.key === "q" || !matchesKey(e, k.key)) continue
      this.#call(`key ${k.key}`, () => k.run(this.#data, this.#control()))
      this.#opts.requestRender?.()
      return true
    }
    return this.#scroll.handleInput(e)
  }

  /** What a key handler gets to act on the view with. */
  #control(): ViewControl {
    return {
      close: () => {
        this.#answer(undefined)
        this.#confirmed(false)
        this.#opts.onClose?.()
      },
      requestRender: () => this.#opts.requestRender?.(),
      prompt: (title, opts) => {
        this.#answer(undefined)
        this.#confirmed(false)
        const input = new LineInput()
        if (opts?.initial) input.value = opts.initial
        return new Promise<string | undefined>((resolve) => {
          this.#prompt = { title: oneLine(title), input, resolve }
          this.#opts.requestRender?.()
        })
      },
      confirm: (question, opts) => {
        this.#answer(undefined)
        this.#confirmed(false)
        const text = `${oneLine(question)} y ${opts?.yes ?? "yes"} ${glyphs.separator} any other key ${opts?.no ?? "cancels"}`
        return new Promise<boolean>((resolve) => {
          this.#confirm = { text, resolve }
          this.#opts.requestRender?.()
        })
      },
    }
  }

  /** Closes the open prompt, if any, with `text` (empty text counts as cancelled). */
  #answer(text: string | undefined) {
    const asking = this.#prompt
    if (!asking) return
    this.#prompt = undefined
    const value = text?.trim()
    asking.resolve(value ? value : undefined)
  }

  /** Answers the open confirmation, if any. */
  #confirmed(yes: boolean) {
    const asking = this.#confirm
    if (!asking) return
    this.#confirm = undefined
    asking.resolve(yes)
  }

  /** The view is being closed by the frontend: an open prompt is cancelled, a question answered no. */
  dispose(): void {
    this.#answer(undefined)
    this.#confirmed(false)
  }

  render(width: number, ctx: RenderContext): string[] {
    const { theme } = ctx
    const opts = { width, now: this.#now() }
    const head: string[] = []
    const title = this.#call("title", () => this.#view.title(this.#data)) ?? this.kind
    head.push(
      truncateToWidth(`${theme.accent(glyphs.subagent)} ${theme.text(oneLine(title))}`, width, glyphs.more),
    )
    const extra = this.#view.header
      ? (this.#call("header", () => this.#view.header?.(this.#data, opts)) ?? [])
      : []
    head.push(...renderToolLines(wrapViewLines(extra, width), theme, width))
    for (const t of this.#opts.waiting?.() ?? []) head.push(waitingLine(theme, t, width))
    head.push(theme.muted(glyphs.rule.repeat(width)))
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
    return renderToolLines(wrapViewLines(lines, width), theme, width)
  }

  #footer(theme: Theme, width: number): string {
    if (this.#confirm) return theme.warning(truncateToWidth(this.#confirm.text, width, glyphs.more))
    const asking = this.#prompt
    if (asking) {
      const label = truncateToWidth(`${asking.title} `, Math.max(1, Math.floor(width / 2)), glyphs.more)
      const room = Math.max(1, width - visibleWidth(label))
      return `${theme.accent(label)}${asking.input.render(room, theme, { focused: true, placeholder: "Enter send · Esc cancel" })}`
    }
    const p = this.#scroll.position
    // The way back stays longest, then the view's own keys; the scroll keys go first.
    const hint = fitHint(
      [
        p.total > p.height && { text: scrollPosition(this.#scroll), priority: 3 },
        ...(this.#view.keys ?? []).map((k) => ({ text: `${k.key} ${k.label}`, priority: 4 })),
        { text: "↑↓ PgUp PgDn Home End scroll", priority: 1 },
        { text: "Esc back", priority: 5 },
      ],
      width,
    )
    return theme.muted(hint)
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
