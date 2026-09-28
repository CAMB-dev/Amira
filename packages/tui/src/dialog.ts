import type { EventMap } from "@amira/api"
import { rankMatches } from "@amira/core"
import {
  type Component,
  Editor,
  type InputEvent,
  matchesKey,
  type RenderContext,
  truncateToWidth,
  wrapText,
} from "@amira/tui-kit"

export type DialogRequest = EventMap["ui.request"]

/** undefined cancels the dialog. */
export type DialogAnswer = string | boolean | undefined

/** Options of a select shown at once; longer lists scroll with the selection. */
const MAX_OPTIONS = 10

/**
 * An inline prompt for one ui.request: y/n for confirm, a list for select and a one-line
 * editor for input. Esc cancels. Calls `onDone` once. Typing in a select filters its options,
 * which matters for long lists such as every model of the catalog.
 */
export class Dialog implements Component {
  #selected = 0
  #filter = ""
  #editor: Editor | undefined
  #done = false

  constructor(
    readonly request: DialogRequest,
    private onDone: (answer: DialogAnswer) => void,
  ) {
    if (request.kind === "input") {
      this.#editor = new Editor({
        prompt: "› ",
        placeholder: request.placeholder ?? "",
        onSubmit: (text) => this.#finish(text),
      })
      if (request.initial) this.#editor.setText(request.initial)
    }
  }

  handleInput(e: InputEvent): boolean {
    if (this.#done) return false
    if (matchesKey(e, "escape")) return this.#finish(undefined)
    const r = this.request
    if (r.kind === "confirm") {
      if (matchesKey(e, "y") || matchesKey(e, "enter")) return this.#finish(true)
      if (matchesKey(e, "n")) return this.#finish(false)
      return false
    }
    if (r.kind === "select") {
      const options = this.#options()
      const n = options.length
      if (matchesKey(e, "up")) this.#selected = n ? (this.#selected - 1 + n) % n : 0
      else if (matchesKey(e, "down") || matchesKey(e, "tab"))
        this.#selected = n ? (this.#selected + 1) % n : 0
      else if (matchesKey(e, "enter")) return n ? this.#finish(options[this.#selected]!) : true
      else if (!this.#filter && e.type === "key" && e.text && /^[1-9]$/.test(e.text) && Number(e.text) <= n) {
        return this.#finish(options[Number(e.text) - 1]!)
      } else if (e.type === "key" && e.name === "backspace" && this.#filter) {
        this.#setFilter(this.#filter.slice(0, -1))
      } else if (e.type === "key" && e.text && !e.ctrl && !e.alt) {
        this.#setFilter(this.#filter + e.text)
      } else return false
      return true
    }
    // An empty input is still an answer; the editor leaves Enter on empty text to us.
    if (this.#editor!.handleInput(e)) return true
    if (matchesKey(e, "enter")) return this.#finish("")
    return false
  }

  render(width: number, ctx: RenderContext): string[] {
    const { theme } = ctx
    const r = this.request
    const from = r.source ? theme.muted(` (${r.source})`) : ""
    const lines = wrapText(`${theme.accent("?")} ${r.title}${from}`, width)
    if (r.kind === "confirm") {
      if (r.message) lines.push(...wrapText(theme.muted(r.message), width))
      lines.push(theme.muted("y yes · n no · Esc cancel"))
    } else if (r.kind === "select") {
      const options = this.#options()
      if (this.#filter) lines.push(`${theme.muted("filter ›")} ${this.#filter}`)
      const start = Math.min(
        Math.max(0, this.#selected - MAX_OPTIONS + 1),
        Math.max(0, options.length - MAX_OPTIONS),
      )
      options.slice(start, start + MAX_OPTIONS).forEach((o, j) => {
        const i = start + j
        const line = i === this.#selected ? `${theme.accent("›")} ${theme.accent(o)}` : `  ${o}`
        const digit = i < 9 && !this.#filter ? theme.muted(` ${i + 1}`) : ""
        lines.push(truncateToWidth(`${line}${digit}`, width, "…"))
      })
      if (!options.length) lines.push(theme.muted("  no match"))
      else if (options.length > MAX_OPTIONS)
        lines.push(theme.muted(`  ${this.#selected + 1}/${options.length}`))
      lines.push(theme.muted("↑↓ move · type to filter · Enter choose · Esc cancel"))
    } else {
      lines.push(...this.#editor!.render(width, ctx))
      lines.push(theme.muted("Enter submit · Esc cancel"))
    }
    return lines
  }

  /** The select's options that match the filter, best first. */
  #options(): string[] {
    return this.request.kind === "select" ? rankMatches(this.#filter, this.request.options, (o) => o) : []
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
