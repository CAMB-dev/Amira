import {
  type Component,
  type InputEvent,
  matchesKey,
  type RenderContext,
  ScrollView,
  type Theme,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"
import {
  ACTIONS,
  type Action,
  type Keybindings,
  type KeyScope,
  type KeySpec,
  keyLabel,
} from "./keybindings.ts"

/** The groups of the reference, in the order they are listed, with their headings. */
const SCOPES: { scope: KeyScope; title: string; fullscreenOnly?: boolean }[] = [
  { scope: "input", title: "Input" },
  { scope: "popup", title: "Command and file lists" },
  { scope: "search", title: "History search" },
  { scope: "dialog", title: "Dialogs" },
  { scope: "view", title: "Extension views" },
  { scope: "transcript", title: "Transcript", fullscreenOnly: true },
  { scope: "select", title: "Block selection", fullscreenOnly: true },
  { scope: "find", title: "Find", fullscreenOnly: true },
  { scope: "text", title: "Text selected with the mouse", fullscreenOnly: true },
]

/** The widest the keys column gets; longer key lists wrap within it. */
const MAX_KEYS_WIDTH = 28

export interface KeyReferenceOptions {
  /** Whether the full-screen view is on: its transcript keys are listed only then. */
  fullscreen: boolean
  /** Called when the user asks to leave it. */
  onClose: () => void
  /**
   * Whether a bound key reaches Amira in this terminal (Shift+Enter may arrive as plain Enter);
   * the others are left out. Default: all do.
   */
  usable?: (action: Action, key: KeySpec) => boolean
}

/**
 * The key reference (the help action): every action with the keys bound to it now, grouped by
 * where it applies, over the whole screen. The body scrolls; Esc, q, Ctrl+C or the help key
 * close it.
 */
export class KeyReference implements Component {
  #scroll: ScrollView
  /** The first render puts it at the top, once its length is known. */
  #placed = false

  constructor(
    private keys: Keybindings,
    private opts: KeyReferenceOptions,
  ) {
    this.#scroll = new ScrollView((width, ctx) => this.#body(width, ctx.theme))
  }

  /** Sub-agents' and the session's events change nothing here. */
  handleEvent(): boolean {
    return false
  }

  handleInput(e: InputEvent): boolean {
    if (
      matchesKey(e, "escape") ||
      matchesKey(e, "q") ||
      matchesKey(e, "c", { ctrl: true }) ||
      this.keys.is(e, "help")
    ) {
      this.opts.onClose()
      return true
    }
    return this.#scroll.handleInput(e)
  }

  render(width: number, ctx: RenderContext): string[] {
    const { theme } = ctx
    const head = [
      truncateToWidth(`${theme.accent(glyphs.question)} ${theme.text("Keys")}`, width, glyphs.more),
      ...wrapText(
        "To change a key, map the action name after its description to keys in keybindings.json, in Amira's home folder (~/.amira unless AMIRA_HOME says otherwise).",
        width,
      ).map((l) => theme.muted(l)),
      theme.muted(glyphs.rule.repeat(width)),
    ]
    this.#scroll.height = Math.max(1, ctx.rows - head.length - 1)
    let body = this.#scroll.render(width, ctx)
    if (!this.#placed) {
      this.#placed = true
      this.#scroll.scrollToTop()
      body = this.#scroll.render(width, ctx)
    }
    return [...head, ...body, this.#footer(theme, width)].slice(0, ctx.rows)
  }

  /** The keys of an action as they read in hints, all of them; "not bound" without any. */
  #labels(action: Action): string | undefined {
    const usable = this.opts.usable
    const specs = this.keys.keys(action).filter((s) => !usable || usable(action, s))
    return specs.length ? specs.map(keyLabel).join(", ") : undefined
  }

  #body(width: number, theme: Theme): string[] {
    const groups = SCOPES.filter((s) => this.opts.fullscreen || !s.fullscreenOnly).map((s) => ({
      ...s,
      rows: (Object.keys(ACTIONS) as Action[])
        .filter(
          (a) =>
            ACTIONS[a].scope === s.scope ||
            (!this.opts.fullscreen && s.scope === "view" && a.startsWith("scroll.")),
        )
        .map((a) => ({ keys: this.#labels(a), description: `${ACTIONS[a].description} · ${a}` })),
    }))
    const widest = Math.max(...groups.flatMap((g) => g.rows.map((r) => visibleWidth(r.keys ?? "not bound"))))
    // Two spaces of indent, the keys column, two spaces, then the description.
    const keysWidth = Math.max(4, Math.min(MAX_KEYS_WIDTH, widest, Math.floor((width - 4) / 3)))
    const textWidth = Math.max(8, width - keysWidth - 4)
    const out: string[] = []
    for (const g of groups) {
      if (out.length) out.push("")
      out.push(theme.accent(truncateToWidth(g.title, width, glyphs.more)))
      for (const r of g.rows) {
        const keyLines = r.keys ? wrapText(r.keys, keysWidth) : ["not bound"]
        const style = r.keys ? theme.text : theme.muted
        const textLines = wrapText(r.description, textWidth)
        for (let i = 0; i < Math.max(keyLines.length, textLines.length); i++) {
          const k = keyLines[i] ?? ""
          const pad = " ".repeat(Math.max(0, keysWidth - visibleWidth(k)))
          const line = `  ${style(k)}${pad}  ${theme.muted(textLines[i] ?? "")}`
          out.push(truncateToWidth(line, width, glyphs.more))
        }
      }
    }
    return out
  }

  #footer(theme: Theme, width: number): string {
    const p = this.#scroll.position
    const where =
      p.total <= p.height
        ? []
        : [p.following ? "end" : `${p.top + 1}–${Math.min(p.total, p.top + p.height)} of ${p.total}`]
    const scroll = ["pageup", "pagedown", "home", "end"].map((name) => keyLabel({ name })).join(" ")
    const hint = [...where, `↑↓ ${scroll} scroll`, `${keyLabel({ name: "escape" })} close`].join(
      ` ${glyphs.separator} `,
    )
    return theme.muted(truncateToWidth(hint, width, glyphs.more))
  }
}
