import {
  type Component,
  type Editor,
  type EditorPart,
  graphemes,
  type InputEvent,
  matchesKey,
  type RenderContext,
  truncateToWidth,
} from "@amira/tui-kit"
import { inputGlyphs } from "./input-glyphs.ts"
import type { PromptHistory } from "./prompt-history.ts"

/** What a key did to the search. */
export type SearchAction =
  | "handled"
  /** The search ended with the match in the editor. */
  | "accepted"
  /** The search ended with the match in the editor, and the key is for the editor too. */
  | "accepted-pass"
  /** The search ended and the editor has its draft back. */
  | "cancelled"

/**
 * Ctrl+R: incremental reverse search through the prompt history. Typing narrows the search, and
 * the editor previews the newest entry containing the query (case-insensitive); Ctrl+R steps to
 * older matches and Ctrl+S back to newer ones. Enter keeps the match in the editor for editing
 * (it does not send it), Esc or Ctrl+C put the draft back, and other keys such as the arrows
 * keep the match and act on it.
 */
export class HistorySearch implements Component {
  #active = false
  #query = ""
  /** Index into the history of the match shown; -1 when there is none. */
  #match = -1
  #draft: EditorPart[] = []

  constructor(
    private history: PromptHistory,
    private editor: Editor,
  ) {}

  get active(): boolean {
    return this.#active
  }

  get query(): string {
    return this.#query
  }

  start(): void {
    this.#active = true
    this.#query = ""
    this.#draft = this.editor.getParts()
    this.#match = -1
  }

  handleKey(e: InputEvent): SearchAction {
    if (e.type === "paste") {
      this.#setQuery(this.#query + e.text.split("\n")[0])
      return "handled"
    }
    if (matchesKey(e, "escape") || matchesKey(e, "c", { ctrl: true }) || matchesKey(e, "g", { ctrl: true })) {
      this.#active = false
      this.editor.setParts(this.#draft)
      return "cancelled"
    }
    if (matchesKey(e, "r", { ctrl: true })) {
      this.#find(this.#match === -1 ? this.history.entries.length - 1 : this.#match - 1, -1)
      return "handled"
    }
    if (matchesKey(e, "s", { ctrl: true })) {
      if (this.#match !== -1) this.#find(this.#match + 1, 1)
      return "handled"
    }
    if (matchesKey(e, "backspace")) {
      const gs = graphemes(this.#query)
      this.#setQuery(gs.slice(0, -1).join(""))
      return "handled"
    }
    if (e.type === "key" && e.text !== undefined && !e.ctrl && !e.alt) {
      this.#setQuery(this.#query + e.text)
      return "handled"
    }
    this.#active = false
    return matchesKey(e, "enter") ? "accepted" : "accepted-pass"
  }

  render(width: number, { theme }: RenderContext): string[] {
    if (!this.#active) return []
    const total = this.#matches()
    const status =
      this.#match !== -1
        ? `${total.indexOf(this.#match) + 1} of ${total.length}`
        : this.#query
          ? "no match"
          : "type to search"
    const line = `${theme.accent(inputGlyphs.search)} ${theme.muted("search history")} ${theme.accent(inputGlyphs.searchPrompt)} ${this.#query}  ${theme.muted(status)}`
    return [truncateToWidth(line, width, "…")]
  }

  #matches(): number[] {
    const q = this.#query.toLowerCase()
    const out: number[] = []
    const entries = this.history.entries
    for (let i = entries.length - 1; i >= 0; i--)
      if (entries[i]!.display.toLowerCase().includes(q)) out.push(i)
    return out
  }

  #setQuery(q: string): void {
    this.#query = q
    // Each query searches from the newest entry again.
    this.#find(this.history.entries.length - 1, -1, true)
  }

  /** Shows the first match from `from` going `dir`; with none, keeps the one shown unless `reset`. */
  #find(from: number, dir: -1 | 1, reset = false): void {
    const entries = this.history.entries
    const q = this.#query.toLowerCase()
    for (let i = from; i >= 0 && i < entries.length; i += dir) {
      if (entries[i]!.display.toLowerCase().includes(q)) {
        this.#match = i
        this.editor.setParts(entries[i]!.parts)
        return
      }
    }
    if (reset) {
      this.#match = -1
      this.editor.setParts(this.#draft)
    }
  }
}
