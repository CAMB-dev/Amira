import type { CommandCandidate, CommandInfo } from "@amira/api"
import {
  type Component,
  type InputEvent,
  isSubmitKey,
  matchesKey,
  type RenderContext,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"

/** Where the popup gets its candidates; the CommandHost in the app. */
export interface CompletionSource {
  complete(line: string): Promise<{ command?: string; candidates: CommandCandidate[] }>
  list(): CommandInfo[]
}

/** What a key did to the popup. */
export type PopupAction =
  | { type: "handled" }
  /** Put this text in the editor (Tab). */
  | { type: "replace"; text: string }
  /** Run this command line (Enter). */
  | { type: "run"; line: string }

/** Rows of candidates shown at once; the list scrolls to keep the selection visible. */
const MAX_ROWS = 8

/** One line of text that starts with a slash: the only input the popup opens for. */
const isCommandInput = (text: string) => /^\/\S*(?:[ \t][^\n]*)?$/.test(text)

interface Result {
  /** The editor text these candidates are for. */
  text: string
  command?: string
  candidates: CommandCandidate[]
}

/**
 * The completion list shown above the editor while the input starts with "/" (D55): command
 * names first, then the command's argument candidates. ↑↓ select, Tab completes, Enter runs,
 * Esc closes until the text changes. Candidates arrive asynchronously; a stale answer is dropped.
 */
export class CommandPopup implements Component {
  #text = ""
  #result: Result = { text: "", candidates: [] }
  #selected = 0
  /** The user moved the selection, so Enter takes it over what was typed. */
  #navigated = false
  #dismissed = false
  #generation = 0

  constructor(
    private source: CompletionSource,
    private onUpdate: () => void,
  ) {}

  /** Call with the editor text whenever it may have changed. */
  update(text: string): void {
    if (text === this.#text) return
    this.#text = text
    this.#dismissed = false
    if (!isCommandInput(text)) {
      this.#generation++
      this.#result = { text: "", candidates: [] }
      return
    }
    const generation = ++this.#generation
    this.source.complete(text).then(
      (r) => {
        if (generation !== this.#generation) return
        this.#result = { text, ...r }
        this.#selected = 0
        this.#navigated = false
        this.onUpdate()
      },
      () => {},
    )
  }

  /** Whether the popup shows anything for the current text. */
  get open(): boolean {
    return !this.#dismissed && this.#current !== undefined && this.#lines().length > 0
  }

  /** Handles a key while open; undefined leaves it to the editor. */
  handleKey(e: InputEvent): PopupAction | undefined {
    const r = this.#current
    if (!this.open || !r) return undefined
    if (matchesKey(e, "escape")) {
      this.#dismissed = true
      return { type: "handled" }
    }
    const n = r.candidates.length
    if (!n) return undefined
    if (matchesKey(e, "up") || matchesKey(e, "down")) {
      const step = matchesKey(e, "up") ? -1 : 1
      this.#selected = (this.#selected + step + n) % n
      this.#navigated = true
      return { type: "handled" }
    }
    const chosen = r.candidates[this.#selected]!.value
    if (matchesKey(e, "tab")) {
      return { type: "replace", text: r.command ? `/${r.command} ${chosen}` : `/${chosen} ` }
    }
    if (!isSubmitKey(e)) return undefined
    if (!r.command) {
      // A bare "/" names nothing yet; Enter only runs a command once one is picked or typed.
      if (r.text === "/" && !this.#navigated) return { type: "handled" }
      return { type: "run", line: `/${chosen}` }
    }
    const typed = r.text.replace(/^\/\S+\s+/, "").trim().toLowerCase()
    // What was typed stands unless the user picked a candidate or typed a piece of the
    // highlighted one. A looser fuzzy match is only a suggestion (Tab): a model or id that is
    // not in the list, like "llama3.3" next to "llama3.1", must not be swapped for it.
    const exact = r.candidates.some((c) => c.value.toLowerCase() === typed)
    const partOf = typed && !exact && chosen.toLowerCase().includes(typed)
    if (this.#navigated || partOf) return { type: "run", line: `/${r.command} ${chosen}` }
    return { type: "run", line: r.text.trim() }
  }

  render(width: number, ctx: RenderContext): string[] {
    return this.open ? this.#lines(ctx, width) : []
  }

  /** The result for the text in the editor, if it has arrived. */
  get #current(): Result | undefined {
    return isCommandInput(this.#text) && this.#result.text === this.#text ? this.#result : undefined
  }

  #lines(ctx?: RenderContext, width = 80): string[] {
    const r = this.#current
    if (!r) return []
    const theme = ctx?.theme
    const muted = (s: string) => (theme ? theme.muted(s) : s)
    const accent = (s: string) => (theme ? theme.accent(s) : s)
    if (!r.candidates.length) {
      // No candidates for the arguments: show how the command is used instead.
      const info = r.command ? this.source.list().find((c) => c.name === r.command) : undefined
      if (!info) return []
      const usage = `/${info.name}${info.hint ? ` ${info.hint}` : ""}  ${info.description}`
      return [muted(truncateToWidth(`  ${usage}`, width, "…"))]
    }
    const n = r.candidates.length
    const start = Math.min(Math.max(0, this.#selected - MAX_ROWS + 1), Math.max(0, n - MAX_ROWS))
    const shown = r.candidates.slice(start, start + MAX_ROWS)
    const label = (c: CommandCandidate) => (r.command ? c.value : `/${c.value}`)
    const col = Math.min(32, Math.max(...shown.map((c) => visibleWidth(label(c)))))
    const lines = shown.map((c, i) => {
      const selected = start + i === this.#selected
      const name = label(c)
      const pad = " ".repeat(Math.max(0, col - visibleWidth(name)))
      const desc = c.description ? `  ${muted(c.description)}` : ""
      const line = selected ? `${accent("›")} ${accent(name)}${pad}${desc}` : `  ${name}${pad}${desc}`
      return truncateToWidth(line, width, "…")
    })
    if (n > MAX_ROWS) lines.push(muted(`  ${this.#selected + 1}/${n}`))
    return lines
  }
}
