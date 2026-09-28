import type { EventMap } from "@amira/api"
import { rankMatches } from "@amira/core"
import {
  type Component,
  Editor,
  type InputEvent,
  LineInput,
  type RenderContext,
  truncateToWidth,
  wrapText,
} from "@amira/tui-kit"
import { parseUnifiedDiff, renderToolLines } from "./diff-view.ts"
import { glyphs } from "./glyphs.ts"
import { fitHint } from "./hint.ts"
import { type Action, defaultKeybindings, type Keybindings } from "./keybindings.ts"

export type DialogRequest = EventMap["ui.request"]

/**
 * Lines cut to `rows`: the start and the end, with a marker in the middle saying how many
 * were left out. The start (file names, first hunk) gets the extra row.
 */
function cutMiddle(lines: string[], rows: number, ctx: RenderContext): string[] {
  if (lines.length <= rows) return lines
  if (rows <= 0) return []
  const keep = rows - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  const marker = ctx.theme.muted(`${glyphs.more} ${lines.length - keep} more lines ${glyphs.more}`)
  return [...lines.slice(0, head), marker, ...lines.slice(lines.length - tail)]
}

/** undefined cancels the dialog. */
export type DialogAnswer = string | boolean | undefined

/** Options of a select shown at once; longer lists scroll with the selection. */
const MAX_OPTIONS = 10

/**
 * An inline prompt for one ui.request: y/n for confirm, a list for select and diff-review, and
 * a one-line editor for input. Esc cancels. Calls `onDone` once. Typing in a select filters its
 * options, which matters for long lists such as every model of the catalog. It fits `maxRows`:
 * the title, the options and the keys always show, and a diff gives up rows from its middle.
 */
export class Dialog implements Component {
  /** Rows the dialog may take; set by the app before each render. */
  maxRows = Number.POSITIVE_INFINITY
  #selected = 0
  #filter = ""
  #editor: Editor | undefined
  /** A secret input: masked, one line, never shown. */
  #secret: LineInput | undefined
  #done = false

  constructor(
    readonly request: DialogRequest,
    private onDone: (answer: DialogAnswer) => void,
    private keys: Keybindings = defaultKeybindings(),
  ) {
    if (request.kind === "input" && request.secret) {
      this.#secret = new LineInput({ mask: "*", accept: (g) => !/\s/.test(g) })
    } else if (request.kind === "input") {
      this.#editor = new Editor({
        prompt: `${glyphs.pointer} `,
        placeholder: request.placeholder ?? "",
        onSubmit: (text) => this.#finish(text),
        isSubmit: (e) => keys.is(e, "dialog.choose"),
        isNewline: () => false,
      })
      if (request.initial) this.#editor.setText(request.initial)
    }
  }

  handleInput(e: InputEvent): boolean {
    if (this.#done) return false
    const keys = this.keys
    if (keys.is(e, "dialog.cancel")) return this.#finish(undefined)
    const r = this.request
    if (r.kind === "confirm") {
      if (keys.is(e, "dialog.yes") || keys.is(e, "dialog.choose")) return this.#finish(true)
      if (keys.is(e, "dialog.no")) return this.#finish(false)
      return false
    }
    if (r.kind === "select" || r.kind === "diff-review") {
      const options = this.#options()
      const n = options.length
      if (keys.is(e, "dialog.up")) this.#selected = n ? (this.#selected - 1 + n) % n : 0
      else if (keys.is(e, "dialog.down")) this.#selected = n ? (this.#selected + 1) % n : 0
      else if (keys.is(e, "dialog.choose")) return n ? this.#finish(options[this.#selected]!) : true
      else if (
        this.#digitsPick &&
        e.type === "key" &&
        e.text &&
        /^[1-9]$/.test(e.text) &&
        Number(e.text) <= n
      ) {
        return this.#finish(options[Number(e.text) - 1]!)
      } else if (r.kind === "select" && e.type === "key" && e.name === "backspace" && this.#filter) {
        this.#setFilter(this.#filter.slice(0, -1))
      } else if (r.kind === "select" && e.type === "key" && e.text && !e.ctrl && !e.alt) {
        this.#setFilter(this.#filter + e.text)
      } else return false
      return true
    }
    if (this.#secret) {
      if (keys.is(e, "dialog.choose")) return this.#finish(this.#secret.value)
      return this.#secret.handleInput(e)
    }
    // An empty input is still an answer; the editor leaves Enter on empty text to us.
    if (this.#editor!.handleInput(e)) return true
    if (keys.is(e, "dialog.choose")) return this.#finish("")
    return false
  }

  render(width: number, ctx: RenderContext): string[] {
    const { theme } = ctx
    const r = this.request
    const from = r.source ? theme.muted(` (${r.source})`) : ""
    const title = wrapText(`${theme.accent(glyphs.question)} ${r.title}${from}`, width)
    const muted = (items: Parameters<typeof fitHint>[0]) => theme.muted(fitHint(items, width))
    const cancel = this.#hint("dialog.cancel", "cancel", 3)
    let body: string[]
    let footer: string[]
    if (r.kind === "confirm") {
      body = r.message ? wrapText(theme.muted(r.message), width) : []
      // Choosing answers yes too, which is the key to show when yes has none of its own.
      const yes = this.#hint("dialog.yes", "yes", 5) ?? this.#hint("dialog.choose", "yes", 5)
      footer = [muted([yes, this.#hint("dialog.no", "no", 5), cancel])]
    } else if (r.kind === "select" || r.kind === "diff-review") {
      return this.#renderList(title, width, ctx)
    } else if (this.#secret) {
      const placeholder = r.kind === "input" ? (r.placeholder ?? "") : ""
      body = [
        `${glyphs.pointer} ${this.#secret.render(Math.max(4, width - 2), theme, { focused: true, placeholder })}`,
      ]
      footer = [muted([this.#hint("dialog.choose", "submit", 5), cancel])]
    } else {
      body = this.#editor!.render(width, ctx)
      footer = [muted([this.#hint("dialog.choose", "submit", 5), cancel])]
    }
    // The title gives way last, and never all of it.
    const room = Math.max(1, this.maxRows - footer.length)
    const lines = [...fitTitle(title, Math.max(1, room - body.length)), ...body]
    return [...lines.slice(0, Math.max(room, 1)), ...footer]
  }

  #renderList(title: string[], width: number, ctx: RenderContext): string[] {
    const { theme } = ctx
    const r = this.request as Extract<DialogRequest, { kind: "select" | "diff-review" }>
    const move = this.keys.pairLabel("dialog.up", "dialog.down")
    const options = this.#options()
    const filter = this.#filter ? [`${theme.muted(`filter ${glyphs.pointer}`)} ${this.#filter}`] : []
    const help = theme.muted(
      fitHint(
        [
          move && { text: `${move} move`, priority: 2 },
          // Only a select filters; a diff review's options are few and fixed.
          r.kind === "select" && { text: "type to filter", priority: 1 },
          this.#hint("dialog.choose", "choose", 4),
          this.#hint("dialog.cancel", "cancel", 3),
        ],
        width,
      ),
    )
    // Rows for everything but the diff; the options shrink to what is left, down to one.
    let shown = Math.min(MAX_OPTIONS, options.length)
    const fixed = (n: number) =>
      title.length + filter.length + Math.max(1, n) + (n < options.length ? 1 : 0) + 1
    while (shown > 1 && fixed(shown) > this.maxRows) shown--
    const start = Math.min(Math.max(0, this.#selected - shown + 1), Math.max(0, options.length - shown))
    const rows = options.slice(start, start + shown).map((o, j) => {
      const i = start + j
      const selected = i === this.#selected
      const digits = i < 9 && this.#digitsPick
      const digit = digits ? `${theme.muted(String(i + 1))} ` : ""
      // An option numbered as its digit ("1. explorer", for frontends without digits) shows once.
      const text = digits && o.startsWith(`${i + 1}. `) ? o.slice(`${i + 1}. `.length) : o
      const marker = selected ? theme.accent(glyphs.pointer) : " "
      return truncateToWidth(`${marker} ${digit}${selected ? theme.accent(text) : text}`, width, glyphs.more)
    })
    if (!options.length) rows.push(theme.muted("  no match"))
    else if (shown < options.length) rows.push(theme.muted(`  ${this.#selected + 1}/${options.length}`))
    const below = [...filter, ...rows, help]
    const titleRows = fitTitle(title, Math.max(1, this.maxRows - below.length))
    const diffRoom = this.maxRows - titleRows.length - below.length
    // The diff styled like a tool's (the presenters' diff lines), cut in the middle to the rows
    // left (a tall terminal shows more of a long one; the full-screen review comes later, D8).
    const diff =
      r.kind === "diff-review"
        ? cutMiddle(renderToolLines(parseUnifiedDiff(r.diff), theme, width), diffRoom, ctx)
        : []
    return [...titleRows, ...diff, ...below]
  }

  /** The select's options that match the filter, best first. */
  #options(): string[] {
    const r = this.request
    if (r.kind === "diff-review") return r.options
    return r.kind === "select" ? rankMatches(this.#filter, r.options, (o) => o) : []
  }

  /**
   * Digits choose an option in a short unfiltered list. A longer list needs them for its
   * filter: model ids like gpt-4o start with or turn on a digit.
   */
  /** A footer item for an action's key; none when the action has no key bound. */
  #hint(action: Action, what: string, priority: number) {
    const key = this.keys.label(action)
    return key ? { text: `${key} ${what}`, priority } : undefined
  }

  get #digitsPick(): boolean {
    const r = this.request
    return (r.kind === "select" || r.kind === "diff-review") && r.options.length <= 9 && !this.#filter
  }

  #setFilter(filter: string) {
    this.#filter = filter
    this.#selected = 0
  }

  #finish(answer: DialogAnswer): true {
    if (!this.#done) {
      this.#done = true
      this.onDone(answer)
    }
    return true
  }
}

/** A wrapped title cut to `rows`, its last row ending in an ellipsis when cut. */
function fitTitle(title: string[], rows: number): string[] {
  if (title.length <= rows) return title
  const kept = title.slice(0, Math.max(1, rows))
  kept[kept.length - 1] = `${kept[kept.length - 1]}${glyphs.more}`
  return kept
}
