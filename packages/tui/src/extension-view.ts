import type {
  CommandOutputLevel,
  ToolLine,
  UiControl,
  UiState,
  ViewControl,
  ViewDefinition,
  ViewKey,
  ViewLine,
  ViewRenderOptions,
} from "@amira/api"
import {
  type Component,
  type InputEvent,
  isSubmitKey,
  LineInput,
  matchesKey,
  type RenderContext,
  ScrollView,
  stripAnsi,
  type Theme,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { terminalText } from "./diff-view.ts"
import { glyphs } from "./glyphs.ts"
import { fitHint, type HintItem } from "./hint.ts"
import {
  keyLabel as bindingLabel,
  defaultKeybindings,
  isTypingKey,
  type Keybindings,
  viewScrollAction,
} from "./keybindings.ts"
import { finishedToolLines, type PresenterSource } from "./tool-view.ts"
import { UiRuntime } from "./ui-runtime/runtime.ts"
import { scrollPosition, waitingLine } from "./view-helpers.ts"
import { renderViewLines, viewTitle } from "./view-lines.ts"

/** Where the TUI finds the view kinds extensions registered. */
export interface ViewSource {
  get(kind: string): ViewDefinition | undefined
}

interface ViewPage {
  title?: string
  data?: unknown
  ui?: UiRuntime
  scrolls: Map<string | undefined, { scroll: ScrollView; placed: boolean }>
}

export interface ExtensionViewerOptions {
  /** Host navigation and scrolling; extension-defined shortcuts remain the extension's. */
  keys?: Keybindings
  /** Initial root-page widget state, applied before lifecycle hooks and the first render. */
  state?: Partial<UiState>
  /** Titles of main-session dialogs waiting for an answer; shown as a banner. */
  waiting?: () => string[]
  now?: () => number
  /** Called when the user (or the view) asks to leave it. */
  onClose?: () => void
  /** Asks for a redraw, for key handlers that changed the data. */
  requestRender?: () => void
  /** Reports a view that threw, e.g. as an extension error; the view shows a line instead. */
  onError?: (error: string) => void
  /** Prints view output into the conversation. */
  onPrint?: (text: string, level?: CommandOutputLevel) => void
  /** Presents finished calls with the same registry as the main transcript. */
  presenters?: PresenterSource
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
    if (l.kind === "segments" || l.kind === "user-message") {
      out.push(l)
      continue
    }
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
 * footer lists the view's own keys. By default, Esc goes back or closes the root; q and Ctrl+C close.
 * The frontend mounts it on a FullScreenRenderer and redraws it as events come.
 */
export class ExtensionViewer implements Component {
  readonly kind: string
  #view: ViewDefinition
  #data: unknown
  #opts: ExtensionViewerOptions
  #keys: Keybindings
  #pages: ViewPage[]
  #mounted = false
  #opening = false
  #disposed = false
  /** Host-rendered tool lines retain their styles without exposing terminal escapes to views. */
  #toolLines = new WeakMap<ViewLine, string>()
  #now: () => number
  #uiOffset = 0
  #uiFrame: { width: number; ctx: RenderContext } | undefined
  #uiDirty = true
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
    this.#keys = opts.keys ?? defaultKeybindings()
    this.#now = opts.now ?? Date.now
    this.#pages = [this.#newPage({ state: opts.state })]
  }

  /** Called after the frontend installs this overlay, before rendering, so onOpen can close it. */
  mount(): void {
    if (this.#mounted || this.#disposed) return
    this.#mounted = true
    this.#opening = true
    try {
      this.#call("onOpen", () => this.#view.onOpen?.(this.#data, this.#uiControl()))
    } finally {
      this.#opening = false
    }
  }

  /** Reentrant opens must not render before initialization finishes. */
  get ready(): boolean {
    return this.#mounted && !this.#opening && !this.#disposed
  }

  get #page(): ViewPage {
    return this.#pages[this.#pages.length - 1]!
  }

  get #ui(): UiRuntime | undefined {
    return this.#page.ui
  }

  #newPage(page: Parameters<ViewControl["pushPage"]>[0]): ViewPage {
    const ui = this.#view.ui
      ? new UiRuntime((event) => {
          this.#call("onEvent", () => this.#view.onEvent?.(event, this.#data, this.#uiControl()))
        }, this.#keys)
      : undefined
    if (page.state) ui?.setState(page.state)
    return { title: page.title, data: page.data, ui, scrolls: new Map() }
  }

  #pushPage(page: Parameters<ViewControl["pushPage"]>[0]): void {
    if (this.#disposed) return
    this.#answer(undefined)
    this.#confirmed(false)
    this.#pages.push(this.#newPage(page))
    this.#uiDirty = true
    this.#opts.requestRender?.()
  }

  #popPage(): void {
    if (this.#disposed || this.#pages.length === 1) return
    this.#answer(undefined)
    this.#confirmed(false)
    this.#pages.pop()!.ui?.dispose()
    this.#uiDirty = true
    this.#opts.requestRender?.()
  }

  #close(): void {
    if (this.#disposed) return
    try {
      this.#opts.onClose?.()
    } finally {
      this.dispose()
    }
  }

  /** Whether this view uses declarative widgets. */
  get declarative(): boolean {
    return !!this.#ui
  }

  /** Shows other data, e.g. when a command opens the same kind again. */
  show(data: unknown, state?: Partial<UiState>): void {
    if (this.#disposed) return
    // A prompt asked about the data shown before is cancelled, not answered for the new one.
    if (data !== this.#data || state !== undefined) {
      this.#answer(undefined)
      this.#confirmed(false)
    }
    this.#data = data
    if (state !== undefined) {
      for (const page of this.#pages) page.ui?.dispose()
      this.#pages = [this.#newPage({ state })]
    }
    this.#uiDirty = true
  }

  get scroll(): ScrollView {
    return this.#scrollState().scroll
  }

  #scrollState() {
    const key = this.#call("scrollKey", () => this.#view.scrollKey?.(this.#data))
    let state = this.#page.scrolls.get(key)
    if (!state) {
      state = {
        scroll: new ScrollView((width, ctx) => this.#body(width, ctx.theme)),
        placed: this.#view.follow !== false,
      }
      this.#page.scrolls.set(key, state)
    }
    return state
  }

  handleInput(e: InputEvent): boolean {
    if (this.#disposed) return false
    if (this.#keys.is(e, "view.close") && !isTypingKey(e)) {
      this.#close()
      return true
    }
    if (this.#uiDirty && this.#uiFrame) this.render(this.#uiFrame.width, this.#uiFrame.ctx)
    if (this.#confirm) {
      if (e.type === "mouse") return true
      // y confirms; any other key says no.
      this.#confirmed(matchesKey(e, "y"))
      this.#opts.requestRender?.()
      return true
    }
    const asking = this.#prompt
    if (asking) {
      if (this.#keys.is(e, "view.back") && !isTypingKey(e)) this.#answer(undefined)
      else if (isSubmitKey(e)) this.#answer(asking.input.value)
      else asking.input.handleInput(e)
      this.#opts.requestRender?.()
      return true
    }
    const typing = this.#ui?.typing && isTypingKey(e)
    if (this.#keys.is(e, "view.back") && !typing) {
      if (this.#ui?.releaseInput()) {
        this.#uiDirty = true
        this.#opts.requestRender?.()
      } else if (this.#pages.length > 1) this.#popPage()
      else this.#close()
      return true
    }
    if (this.#keys.is(e, "view.close") && !typing) {
      this.#close()
      return true
    }
    if (this.#ui) {
      this.#uiDirty = true
      const input = e.type === "mouse" ? { ...e, y: e.y - this.#uiOffset } : e
      if (this.#call("ui input", () => this.#ui!.handleInput(input, false))) {
        this.#opts.requestRender?.()
        return true
      }
    }
    for (const k of this.#view.keys ?? []) {
      if (!usable(k.key)) continue
      const named = NAMED.has(k.key)
      const match =
        k.key === "shift-tab"
          ? matchesKey(e, "tab", { shift: true })
          : matchesKey(e, k.key, named ? { shift: false } : {})
      if (!match) continue
      if (this.#ui) this.#call(`key ${k.key}`, () => this.#ui!.key(k.key))
      else this.#call(`key ${k.key}`, () => k.run?.(this.#data, this.#control()))
      this.#opts.requestRender?.()
      return true
    }
    if (this.#ui) {
      const handled = !!this.#call("ui scroll", () => this.#ui!.handleScroll(e))
      if (handled) this.#opts.requestRender?.()
      return handled
    }
    if (e.type === "mouse") {
      if (e.action !== "wheel" || (e.button !== "up" && e.button !== "down")) return false
      this.scroll.scrollBy(e.button === "up" ? -3 : 3)
      return true
    }
    const action = viewScrollAction(this.#keys, e)
    const scroll = this.scroll
    const page = Math.max(1, scroll.height - 1)
    if (action === "up") scroll.scrollBy(-1)
    else if (action === "down") scroll.scrollBy(1)
    else if (action === "page-up") scroll.scrollBy(-page)
    else if (action === "page-down") scroll.scrollBy(page)
    else if (action === "top") scroll.scrollToTop()
    else if (action === "bottom") scroll.scrollToEnd()
    else return false
    return true
  }

  #uiControl(): UiControl {
    return {
      ...this.#control(),
      setState: (patch) => {
        this.#ui?.setState(patch)
        this.#uiDirty = true
        this.#opts.requestRender?.()
      },
      focus: (id) => {
        this.#ui?.focus(id)
        this.#uiDirty = true
        this.#opts.requestRender?.()
      },
    }
  }

  /** What a key handler gets to act on the view with. */
  #control(): ViewControl {
    return {
      close: () => this.#close(),
      pushPage: (page) => this.#pushPage(page),
      popPage: () => this.#popPage(),
      requestRender: () => {
        this.#uiDirty = true
        this.#opts.requestRender?.()
      },
      print: (text, level) => this.#opts.onPrint?.(text, level),
      prompt: (title, opts) => {
        this.#answer(undefined)
        this.#confirmed(false)
        const input = new LineInput()
        if (opts?.initial) input.value = terminalText(opts.initial)
        return new Promise<string | undefined>((resolve) => {
          this.#prompt = { title: oneLine(title), input, resolve }
          this.#opts.requestRender?.()
        })
      },
      confirm: (question, opts) => {
        this.#answer(undefined)
        this.#confirmed(false)
        const text = `${oneLine(question)} y ${oneLine(opts?.yes ?? "yes")} ${glyphs.separator} any other key ${oneLine(opts?.no ?? "cancels")}`
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
    if (this.#disposed) return
    this.#disposed = true
    this.#answer(undefined)
    this.#confirmed(false)
    for (const page of this.#pages) {
      page.scrolls.clear()
      page.ui?.dispose()
    }
    this.#uiFrame = undefined
    if (this.#mounted) this.#call("onClose", () => this.#view.onClose?.(this.#data))
  }

  render(width: number, ctx: RenderContext): string[] {
    if (this.#ui) return this.#renderUi(width, ctx)
    const { theme } = ctx
    const opts = this.#renderOptions(width, theme)
    const head: string[] = []
    const title =
      this.#page.title ?? this.#call("title", () => this.#view.title(this.#data, opts)) ?? this.kind
    const asideText = this.#view.titleAside
      ? oneLine(this.#call("titleAside", () => this.#view.titleAside?.(this.#data)) ?? "")
      : ""
    const aside = asideText ? theme.muted(truncateToWidth(` ${asideText}`, width, glyphs.more)) : ""
    // The aside stays at the right end; the title is cut first on a narrow screen.
    const room = width - visibleWidth(aside)
    const fitted =
      typeof title === "string"
        ? truncateToWidth(
            `${theme.accent(glyphs.subagent)} ${theme.text(oneLine(title))}`,
            Math.max(1, room),
            glyphs.more,
          )
        : viewTitle(title, theme, Math.max(1, room))
    head.push(aside ? fitted + " ".repeat(Math.max(0, room - visibleWidth(fitted))) + aside : fitted)
    const extra = this.#view.header
      ? (this.#call("header", () => this.#view.header?.(this.#data, opts)) ?? [])
      : []
    head.push(...this.#renderLines(extra, width, theme))
    for (const t of this.#opts.waiting?.() ?? []) head.push(waitingLine(theme, t, width))
    head.push(theme.muted(glyphs.rule.repeat(width)))
    const state = this.#scrollState()
    const scroll = state.scroll
    scroll.height = Math.max(1, ctx.rows - head.length - this.#footerHeight)
    let body = scroll.render(width, ctx)
    if (!state.placed) {
      // Content is known only after a render: then it can start at the top.
      state.placed = true
      scroll.scrollToTop()
      body = scroll.render(width, ctx)
    }
    return [...head, ...body, ...this.#footer(theme, width)].slice(0, ctx.rows)
  }

  #renderUi(width: number, ctx: RenderContext): string[] {
    const runtime = this.#ui!
    this.#uiFrame = { width, ctx }
    this.#uiDirty = false
    const head =
      this.#page.title !== undefined && ctx.rows > 1
        ? [viewTitle({ kind: "accent", text: oneLine(this.#page.title) }, ctx.theme, width)]
        : []
    this.#uiOffset = head.length
    const waiting = (this.#opts.waiting?.() ?? [])
      .slice(0, Math.max(0, ctx.rows - head.length - this.#footerHeight))
      .map((t) => waitingLine(ctx.theme, terminalText(t), width))
    const height = Math.max(0, ctx.rows - head.length - waiting.length - this.#footerHeight)
    let body = this.#call("ui", () => {
      // A repaired selection/tab/focus may change extension-built details in this same frame.
      // Bound stabilization so a view whose content oscillates with state cannot spin forever.
      for (let attempt = 0; attempt < 8; attempt++) {
        const node = this.#view.ui!(this.#data, {
          ...this.#renderOptions(width, ctx.theme),
          height,
          state: runtime.state,
        })
        const frame = runtime.render(
          node,
          width,
          height,
          ctx.theme,
          (lines, w) => this.#renderLines(lines, w, ctx.theme),
          !this.#prompt && !this.#confirm,
        )
        if (!runtime.reconciled) return frame
      }
      throw new Error("UI state did not stabilize")
    })
    if (!body) {
      runtime.clearFrame()
      const title =
        this.#call("title", () => this.#view.title(this.#data, this.#renderOptions(width, ctx.theme))) ??
        this.kind
      body = this.#renderLines(
        [
          typeof title === "string" ? { kind: "accent", text: title } : title,
          {
            kind: "error",
            text: `The ${this.kind} view failed: ${this.#failed.get("ui") ?? "unknown error"}`,
          },
        ],
        width,
        ctx.theme,
      )
    }
    while (body.length < height) body.push("")
    return [...head, ...body.slice(0, height), ...waiting, ...this.#footer(ctx.theme, width)].slice(
      0,
      ctx.rows,
    )
  }

  #body(width: number, theme: Theme): string[] {
    const lines: ViewLine[] = this.#call("render", () =>
      this.#view.render?.(this.#data, this.#renderOptions(width, theme)),
    ) ?? [
      {
        kind: "error",
        text: `The ${this.kind} view failed: ${this.#failed.get("render") ?? "unknown error"}`,
      },
    ]
    return this.#renderLines(lines, width, theme)
  }

  #renderOptions(width: number, theme: Theme): ViewRenderOptions {
    return {
      width,
      now: this.#now(),
      ...(this.#pages.length > 1 ? { page: { depth: this.#pages.length - 1, data: this.#page.data } } : {}),
      renderTool: (name, call, detail) =>
        finishedToolLines(theme, this.#opts.presenters?.get(name), { ...call, name }, detail, width).map(
          (text) => {
            const line: ViewLine = { kind: "code", text: stripAnsi(text) }
            this.#toolLines.set(line, text)
            return line
          },
        ),
    }
  }

  #renderLines(lines: ViewLine[], width: number, theme: Theme): string[] {
    const out: string[] = []
    let plain: ViewLine[] = []
    const flush = () => {
      out.push(...renderViewLines(plain, theme, width))
      plain = []
    }
    for (const line of wrapViewLines(lines, width)) {
      const tool = this.#toolLines.get(line)
      if (tool !== undefined) {
        flush()
        out.push(tool)
      } else plain.push(line)
    }
    flush()
    return out
  }

  get #footerHeight(): number {
    return this.#prompt || this.#confirm || this.#view.hostKeys !== "none" ? 1 : 0
  }

  #footer(theme: Theme, width: number): string[] {
    return this.#footerHeight ? [this.#keyBar(theme, width)] : []
  }

  #navigationLabel(action: "view.back" | "view.close", typing = !!this.#ui?.typing): string | undefined {
    const spec = this.#keys
      .keys(action)
      .find((s) => !typing || s.ctrl || s.alt || (s.name.length > 1 && s.name !== "space"))
    return spec && bindingLabel(spec)
  }

  #backHint(): string {
    const back = this.#navigationLabel("view.back")
    const close = this.#navigationLabel("view.close")
    return back ? `${back} ${this.#pages.length > 1 ? "back" : "close"}` : close ? `${close} close` : ""
  }

  #scrollHint(): string {
    const keys = this.#keys
    const labels = [keys.label("scroll.page-up"), keys.label("scroll.page-down")]
    if (!this.#ui) {
      labels.unshift(
        keys.pairLabel("view.scroll-up", "view.scroll-down") ?? keys.pairLabel("scroll.up", "scroll.down"),
      )
      // Prefer the familiar Home/End hints when those keys are still bound.
      const plain = (s: { ctrl: boolean; alt: boolean; shift?: boolean }) => !s.ctrl && !s.alt && !s.shift
      labels.push(keys.label("scroll.top", plain), keys.label("scroll.bottom", plain))
    }
    const label = labels.filter(Boolean).join(" ")
    return label ? `${label} scroll` : ""
  }

  #keyBar(theme: Theme, width: number): string {
    if (this.#confirm) return theme.warning(truncateToWidth(this.#confirm.text, width, glyphs.more))
    const asking = this.#prompt
    if (asking) {
      const label = truncateToWidth(`${asking.title} `, Math.max(1, Math.floor(width / 2)), glyphs.more)
      const room = Math.max(1, width - visibleWidth(label))
      const back = this.#navigationLabel("view.back", true)
      const placeholder = `Enter send${back ? ` ${glyphs.separator} ${back} cancel` : ""}`
      return `${theme.accent(label)}${asking.input.render(room, theme, { focused: true, placeholder })}`
    }
    if (this.#view.hostKeys === "minimal")
      return theme.muted(truncateToWidth(this.#backHint(), width, glyphs.more))
    if (this.#ui)
      return theme.muted(
        fitHint(
          [
            ...keyHints(this.#view.keys ?? []),
            { text: "Tab focus · arrows navigate · Enter open/send", priority: 2 },
            { text: this.#scrollHint(), priority: 1 },
            { text: this.#backHint(), priority: 5 },
          ],
          width,
        ),
      )
    const scroll = this.scroll
    const p = scroll.position
    // The way back stays longest, then the view's own keys; the scroll keys go first.
    const hint = fitHint(
      [
        (p.total > p.height || !!this.#view.scrollKey) && { text: scrollPosition(scroll), priority: 3 },
        ...keyHints(this.#view.keys ?? []),
        { text: this.#scrollHint(), priority: 1 },
        { text: this.#backHint(), priority: 5 },
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

const NAMED: ReadonlySet<string> = new Set(["left", "right", "tab", "shift-tab"])
const ARROWS: ReadonlySet<string> = new Set(["left", "right"])

/** A key a view may handle: one character other than q (the host's), or a named navigation key. */
function usable(key: string): boolean {
  return NAMED.has(key) || (key.length === 1 && key !== "q")
}

/**
 * Footer items for a view's keys: keys sharing a label share an item ("←→ switch",
 * "→ Tab next"), in the order their labels first appear; keys with an empty label are left out.
 */
function keyHints(keys: readonly ViewKey[]): HintItem[] {
  const groups = new Map<string, string[]>()
  for (const k of keys) {
    const label = oneLine(k.label)
    if (!label || !usable(k.key)) continue
    groups.set(label, [...(groups.get(label) ?? []), k.key])
  }
  return [...groups].map(([label, names]) => ({
    text: `${names.map(keyLabel).join(names.every((n) => ARROWS.has(n)) ? "" : " ")} ${label}`,
    // A view's own letters outlast its navigation keys.
    priority: names.some((n) => n.length === 1) ? 4 : 2,
  }))
}

function keyLabel(key: string): string {
  const labels: Record<string, string> = { left: "←", right: "→", tab: "Tab", "shift-tab": "Shift+Tab" }
  return labels[key] ?? terminalText(key)
}

function oneLine(s: string): string {
  return terminalText(s).replace(/\s+/g, " ").trim()
}
