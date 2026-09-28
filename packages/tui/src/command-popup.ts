import type { CommandCandidate, CommandInfo } from "@amira/api"
import {
  type Component,
  type InputEvent,
  type RenderContext,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import { defaultKeybindings, type Keybindings } from "./keybindings.ts"

type Completion = { command?: string; candidates: CommandCandidate[] }

/** Where the popup gets its candidates; the CommandHost in the app. */
export interface CompletionSource {
  /** Answers at once when it can (command names always), so the list shows with the key. */
  complete(line: string): Completion | Promise<Completion>
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
 * The completion list shown below the editor while the input starts with "/" (D55): command
 * names first (with their aliases, and settings aliases with what they run), then the command's
 * argument candidates. ↑↓ select, Tab completes, Enter runs, Esc closes until the text changes.
 * Candidates the source has at once apply at once; late ones call `onUpdate`, and a stale
 * answer is dropped.
 */
export class CommandPopup implements Component {
  #text = ""
  #result: Result = { text: "", candidates: [] }
  #selected = 0
  /** The user moved the selection, so Enter takes it over what was typed. */
  #navigated = false
  #dismissed = false
  #generation = 0
  /** Settles when the candidates for `#text` arrive, while they are on their way. */
  #pending: Promise<void> | undefined

  constructor(
    private source: CompletionSource,
    private onUpdate: () => void,
    private keys: Keybindings = defaultKeybindings(),
  ) {}

  /**
   * Call with the editor text whenever it changed; not while rendering, since a completer may
   * take a while. Returns a promise while the candidates are on their way, so the caller can
   * wait a moment for them before drawing.
   */
  update(text: string): Promise<void> | undefined {
    if (text === this.#text) return this.#pending
    this.#text = text
    this.#dismissed = false
    this.#pending = undefined
    const generation = ++this.#generation
    if (!isCommandInput(text)) {
      this.#result = { text: "", candidates: [] }
      return undefined
    }
    const apply = (r: Completion) => {
      this.#result = { text, ...r }
      this.#selected = 0
      this.#navigated = false
    }
    let answer: Completion | Promise<Completion>
    try {
      answer = this.source.complete(text)
    } catch {
      answer = { candidates: [] }
    }
    if (typeof (answer as { then?: unknown }).then !== "function") {
      apply(answer as Completion)
      return undefined
    }
    this.#pending = Promise.resolve(answer).then(
      (r) => {
        if (generation !== this.#generation) return
        this.#pending = undefined
        apply(r)
        this.onUpdate()
      },
      () => {
        if (generation === this.#generation) this.#pending = undefined
      },
    )
    return this.#pending
  }

  /** Whether the popup shows anything for the current text, so it answers keys. */
  get open(): boolean {
    return !this.#dismissed && this.#current !== undefined && this.#lines(this.#current).length > 0
  }

  /**
   * Whether the popup is drawn. While the candidates for newly typed text are on their way, the
   * last list stays up: dropping it for that frame made the popup and everything below flicker
   * on each key. Keys still wait for the fresh list (see `open`).
   */
  get visible(): boolean {
    const r = this.#shown
    return !this.#dismissed && r !== undefined && this.#lines(r).length > 0
  }

  /** Handles a key while open; undefined leaves it to the editor. */
  handleKey(e: InputEvent): PopupAction | undefined {
    const r = this.#current
    if (!this.open || !r) return undefined
    if (this.keys.is(e, "popup.close")) {
      this.#dismissed = true
      return { type: "handled" }
    }
    const n = r.candidates.length
    if (!n) return undefined
    if (this.keys.is(e, "popup.up") || this.keys.is(e, "popup.down")) {
      const step = this.keys.is(e, "popup.up") ? -1 : 1
      this.#selected = (this.#selected + step + n) % n
      this.#navigated = true
      return { type: "handled" }
    }
    const chosen = r.candidates[this.#selected]!.value
    if (this.keys.is(e, "popup.complete")) {
      return { type: "replace", text: r.command ? `/${r.command} ${chosen}` : `/${chosen} ` }
    }
    if (!this.keys.is(e, "popup.accept")) return undefined
    if (!r.command) {
      // A bare "/" names nothing yet; Enter only runs a command once one is picked or typed.
      if (r.text === "/" && !this.#navigated) return { type: "handled" }
      return { type: "run", line: `/${chosen}` }
    }
    const typed = r.text
      .replace(/^\/\S+\s+/, "")
      .trim()
      .toLowerCase()
    // What was typed stands unless the user picked a candidate or typed a piece of the
    // highlighted one. A looser fuzzy match is only a suggestion (Tab): a model or id that is
    // not in the list, like "llama3.3" next to "llama3.1", must not be swapped for it.
    const exact = r.candidates.some((c) => c.value.toLowerCase() === typed)
    const partOf = typed && !exact && chosen.toLowerCase().includes(typed)
    if (this.#navigated || partOf) return { type: "run", line: `/${r.command} ${chosen}` }
    return { type: "run", line: r.text.trim() }
  }

  render(width: number, ctx: RenderContext): string[] {
    const r = this.#shown
    return r && this.visible ? this.#lines(r, ctx, width) : []
  }

  /** The result for the text in the editor, if it has arrived. */
  get #current(): Result | undefined {
    return isCommandInput(this.#text) && this.#result.text === this.#text ? this.#result : undefined
  }

  /** What to draw: the current result, or the last one while the next is pending. */
  get #shown(): Result | undefined {
    return isCommandInput(this.#text) && this.#result.text ? this.#result : undefined
  }

  #lines(r: Result, ctx?: RenderContext, width = 80): string[] {
    const theme = ctx?.theme
    const muted = (s: string) => (theme ? theme.muted(s) : s)
    const accent = (s: string) => (theme ? theme.accent(s) : s)
    if (!r.candidates.length) {
      // No candidates for the arguments: show how the command is used instead.
      const info = r.command ? this.source.list().find((c) => c.name === r.command) : undefined
      if (!info) return []
      const aliases = info.aliases.length ? ` (${info.aliases.join(", ")})` : ""
      const usage = `/${info.name}${aliases}${info.hint ? ` ${info.hint}` : ""}  ${info.description}`
      return [muted(truncateToWidth(`  ${usage}`, width, "…"))]
    }
    const n = r.candidates.length
    const start = Math.min(Math.max(0, this.#selected - MAX_ROWS + 1), Math.max(0, n - MAX_ROWS))
    const shown = r.candidates.slice(start, start + MAX_ROWS)
    // A command row shows its aliases, a settings alias what it runs: "/quit (exit, q)".
    const label = (c: CommandCandidate) => `${r.command ? "" : "/"}${c.label ?? c.value}`
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
