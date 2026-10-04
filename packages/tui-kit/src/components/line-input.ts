import { CURSOR_MARKER } from "../component.ts"
import type { InputEvent } from "../keys.ts"
import type { Theme } from "../style.ts"
import { graphemes, truncateToWidth, visibleWidth } from "../width.ts"

export interface LineInputOptions {
  /** Draws every character as this one, for passwords and API keys. */
  mask?: string
  /** Characters kept from typing and pasting; others are dropped. Default: all. */
  accept?: (grapheme: string) => boolean
}

/** Control characters, including tabs and line breaks, that a one-line input never keeps. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const CONTROL = /[\x00-\x1f\x7f\x9b]/g

/**
 * A one-line text input: typing and pasting insert at the caret (line breaks and tabs become
 * spaces, other control characters are dropped), ←/→ Home/End move, Backspace/Delete remove,
 * Ctrl/Alt with them work by word, Ctrl+U/Ctrl+K cut to the start/end. It works on grapheme
 * clusters, so CJK text and emoji move and delete as one character, and it scrolls sideways
 * to keep the caret in view. It only edits; which keys it leaves (Enter, Tab, ↑↓, Esc) is up
 * to its owner.
 */
export class LineInput {
  private g: string[] = []
  private at = 0
  /** First grapheme shown, as of the last render. */
  private offset = 0

  constructor(private opts: LineInputOptions = {}) {}

  get value(): string {
    return this.g.join("")
  }

  /** Replaces the text; the caret goes to its end. */
  set value(text: string) {
    this.g = this.clean(text)
    this.at = this.g.length
    this.offset = 0
  }

  /** Caret position in grapheme clusters. */
  get cursor(): number {
    return this.at
  }

  insert(text: string): void {
    const add = this.clean(text)
    if (!add.length) return
    // Not splice(..., ...add): a huge paste would overflow the argument list.
    this.g = this.g.slice(0, this.at).concat(add, this.g.slice(this.at))
    this.at += add.length
  }

  /** Returns false for keys it does not use. */
  handleInput(e: InputEvent): boolean {
    if (e.type === "focus" || e.type === "mouse") return false
    if (e.type === "paste") {
      this.insert(e.text)
      return true
    }
    if (e.text !== undefined && !e.ctrl && !e.alt) {
      this.insert(e.text)
      return true
    }
    const word = e.ctrl || e.alt
    switch (e.name) {
      case "backspace":
        return this.remove(word ? this.wordLeft() : Math.max(0, this.at - 1), this.at)
      case "delete":
        return this.remove(this.at, word ? this.wordRight() : Math.min(this.g.length, this.at + 1))
      case "left":
        return this.move(word ? this.wordLeft() : this.at - 1)
      case "right":
        return this.move(word ? this.wordRight() : this.at + 1)
      case "home":
        return this.move(0)
      case "end":
        return this.move(this.g.length)
    }
    if (e.ctrl && !e.alt) {
      if (e.name === "a") return this.move(0)
      if (e.name === "e") return this.move(this.g.length)
      if (e.name === "u") return this.remove(0, this.at)
      if (e.name === "k") return this.remove(this.at, this.g.length)
      if (e.name === "w") return this.remove(this.wordLeft(), this.at)
    }
    return false
  }

  /**
   * The input as one line of at most `width` cells, with `CURSOR_MARKER` at the caret when
   * focused. An empty input shows the placeholder, muted.
   */
  render(width: number, theme: Theme, opts: { focused?: boolean; placeholder?: string } = {}): string {
    const caret = opts.focused ? CURSOR_MARKER : ""
    if (!this.g.length) {
      return caret + (opts.placeholder ? theme.muted(truncateToWidth(opts.placeholder, width - 1, "…")) : "")
    }
    const shown = this.opts.mask ? this.g.map(() => this.opts.mask!) : this.g
    const widths = shown.map((s) => visibleWidth(s))
    // One cell stays free for the caret after the last character.
    const room = Math.max(1, width - 1)
    if (this.at < this.offset) this.offset = this.at
    const before = () => widths.slice(this.offset, this.at).reduce((a, b) => a + b, 0)
    while (this.offset < this.at && before() > room) this.offset++
    // Scrolled further than needed (text deleted, or the input got wider): show more.
    while (this.offset > 0 && widths.slice(this.offset - 1).reduce((a, b) => a + b, 0) <= room) this.offset--
    let out = ""
    let used = 0
    for (let i = this.offset; i < shown.length; i++) {
      if (i === this.at) out += caret
      if (used + widths[i]! > width) break
      out += shown[i]
      used += widths[i]!
    }
    if (this.at === shown.length) out += caret
    return out
  }

  private clean(text: string): string[] {
    const flat = text.replace(/\r\n|[\r\n\t]/g, " ").replace(CONTROL, "")
    const accept = this.opts.accept
    return accept ? graphemes(flat).filter(accept) : graphemes(flat)
  }

  private move(to: number): true {
    this.at = Math.max(0, Math.min(this.g.length, to))
    return true
  }

  private remove(from: number, to: number): true {
    if (to > from) {
      this.g = this.g.slice(0, from).concat(this.g.slice(to))
      this.at = from
    }
    return true
  }

  private wordLeft(): number {
    let i = this.at
    while (i > 0 && /\s/.test(this.g[i - 1]!)) i--
    while (i > 0 && !/\s/.test(this.g[i - 1]!)) i--
    return i
  }

  private wordRight(): number {
    let i = this.at
    while (i < this.g.length && /\s/.test(this.g[i]!)) i++
    while (i < this.g.length && !/\s/.test(this.g[i]!)) i++
    return i
  }
}
