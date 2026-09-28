import type { EventMap } from "@amira/api"
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

/**
 * An inline prompt for one ui.request: y/n for confirm, a list for select and a one-line
 * editor for input. Esc cancels. Calls `onDone` once.
 */
export class Dialog implements Component {
  #selected = 0
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
      const n = r.options.length
      if (matchesKey(e, "up")) this.#selected = (this.#selected - 1 + n) % n
      else if (matchesKey(e, "down") || matchesKey(e, "tab")) this.#selected = (this.#selected + 1) % n
      else if (matchesKey(e, "enter") && n) return this.#finish(r.options[this.#selected]!)
      else if (e.type === "key" && e.text && /^[1-9]$/.test(e.text) && Number(e.text) <= n) {
        return this.#finish(r.options[Number(e.text) - 1]!)
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
      r.options.forEach((o, i) => {
        const line = i === this.#selected ? `${theme.accent("›")} ${theme.accent(o)}` : `  ${o}`
        lines.push(truncateToWidth(`${line}${i < 9 ? theme.muted(` ${i + 1}`) : ""}`, width, "…"))
      })
      lines.push(theme.muted("↑↓ move · Enter choose · Esc cancel"))
    } else {
      lines.push(...this.#editor!.render(width, ctx))
      lines.push(theme.muted("Enter submit · Esc cancel"))
    }
    return lines
  }

  #finish(answer: DialogAnswer): true {
    if (!this.#done) {
      this.#done = true
      this.onDone(answer)
    }
    return true
  }
}
