import {
  bold,
  type Component,
  type InputEvent,
  LineInput,
  matchesKey,
  type RenderContext,
  ScrollView,
  type Theme,
  themeToken,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { dockKeyHelp } from "./app/dock.ts"
import { glyphs, viewEllipsis } from "./glyphs.ts"
import { fitHint, styleHint } from "./hint.ts"
import {
  ACTIONS,
  type Action,
  type Keybindings,
  type KeyScope,
  type KeySpec,
  keyLabel,
} from "./keybindings.ts"

/** The groups of the reference, in the order they are listed, with their headings. */
const SCOPES: { scope: KeyScope; title: string }[] = [
  { scope: "input", title: "Input" },
  { scope: "popup", title: "Command and file lists" },
  { scope: "search", title: "History search" },
  { scope: "dialog", title: "Dialogs" },
  { scope: "view", title: "Extension views" },
  { scope: "transcript", title: "Transcript" },
  { scope: "select", title: "Block selection" },
  { scope: "find", title: "Find" },
  { scope: "text", title: "Text selected with the mouse" },
]

/** The widest the keys column gets; longer key lists wrap within it. */
const MAX_KEYS_WIDTH = 28

export interface KeyReferenceOptions {
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
  #filtering = false
  #filter = new LineInput()

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
    if (this.#filtering) {
      if (matchesKey(e, "c", { ctrl: true })) {
        this.opts.onClose()
        return true
      }
      if (matchesKey(e, "escape")) {
        this.#filtering = false
        this.#filter.value = ""
        this.#scroll.scrollToTop()
        return true
      }
      if (matchesKey(e, "enter")) {
        this.#filtering = false
        return true
      }
      const before = this.#filter.value
      if (this.#filter.handleInput(e)) {
        if (this.#filter.value !== before) this.#scroll.scrollToTop()
        return true
      }
      return this.#scroll.handleInput(e)
    }
    if (matchesKey(e, "/") && e.type === "key" && !e.ctrl && !e.alt) {
      this.#filtering = true
      return true
    }
    if (
      matchesKey(e, "escape") ||
      matchesKey(e, "q") ||
      matchesKey(e, "c", { ctrl: true }) ||
      this.keys.is(e, "help")
    ) {
      this.opts.onClose()
      return true
    }
    if (matchesKey(e, "j")) {
      this.#scroll.scrollBy(1)
      return true
    }
    if (matchesKey(e, "k")) {
      this.#scroll.scrollBy(-1)
      return true
    }
    return this.#scroll.handleInput(e)
  }

  render(width: number, ctx: RenderContext): string[] {
    const { theme } = ctx
    const filterRow =
      this.#filtering || this.#filter.value
        ? [
            `  ${theme.accent(glyphs.search)} ${theme.muted("filter:")} ${this.#filter.render(
              Math.max(4, width - 12),
              theme,
              { focused: this.#filtering, placeholder: "action, key, or description" },
            )}`,
          ]
        : []
    const head = [
      truncateToWidth(`  ${bold(theme.text("Keys"))}`, width, viewEllipsis()),
      ...wrapText(
        "To change a key, map the action name after its description to keys in keybindings.json, in Amira's home folder (~/.amira unless AMIRA_HOME says otherwise).",
        Math.max(1, width - 2),
      ).map((l) => `  ${theme.muted(l)}`),
      ...filterRow,
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
    return specs.length ? specs.map((spec) => keyLabel(spec)).join(", ") : undefined
  }

  #body(width: number, theme: Theme): string[] {
    const query = this.#filter.value.trim().toLowerCase()
    const rawGroups = SCOPES.map((s) => ({
      ...s,
      rows: (Object.keys(ACTIONS) as Action[])
        .filter((a) => ACTIONS[a].scope === s.scope)
        .map((a) => ({
          keys: this.#labels(a),
          description: ACTIONS[a].description,
          action: a as string,
        })),
    }))
    rawGroups.push({
      scope: "view",
      title: "Docked views",
      rows: dockKeyHelp(this.keys).map((r) => ({ ...r, action: "" })),
    })
    const groups = query
      ? rawGroups
          .map((g) => ({
            ...g,
            rows: g.rows.filter(
              (r) =>
                g.title.toLowerCase().includes(query) ||
                (r.keys ?? "not bound").toLowerCase().includes(query) ||
                r.description.toLowerCase().includes(query) ||
                r.action.toLowerCase().includes(query),
            ),
          }))
          .filter((g) => g.rows.length > 0)
      : rawGroups
    if (!groups.length) return [`  ${theme.warning(`no keys match "${this.#filter.value.trim()}"`)}`]
    const widest = Math.max(...groups.flatMap((g) => g.rows.map((r) => visibleWidth(r.keys ?? "not bound"))))
    // Two spaces of indent, the keys column, two spaces, then the description.
    const keysWidth = Math.max(4, Math.min(MAX_KEYS_WIDTH, widest, Math.floor((width - 4) / 3)))
    const textWidth = Math.max(8, width - keysWidth - 4)
    const dim = themeToken(theme, "dim") ?? theme.muted
    const out: string[] = []
    for (const g of groups) {
      if (out.length) out.push("")
      out.push(
        `  ${(themeToken(theme, "heading") ?? theme.text)(bold(truncateToWidth(g.title, Math.max(1, width - 2), viewEllipsis())))}`,
      )
      for (const r of g.rows) {
        const keyLines = r.keys ? wrapText(r.keys, keysWidth) : ["not bound"]
        const style = r.keys ? theme.text : theme.muted
        const full = r.action ? `${r.description} ${glyphs.separator} ${r.action}` : r.description
        const textLines = wrapText(full, textWidth)
        const actionTail = r.action ? ` ${glyphs.separator} ${r.action}` : ""
        for (let i = 0; i < Math.max(keyLines.length, textLines.length); i++) {
          const k = keyLines[i] ?? ""
          const pad = " ".repeat(Math.max(0, keysWidth - visibleWidth(k)))
          const t = textLines[i] ?? ""
          const styledText =
            actionTail && t.endsWith(actionTail)
              ? `${theme.muted(t.slice(0, -actionTail.length))}${dim(actionTail)}`
              : theme.muted(t)
          const line = `  ${style(k)}${pad}  ${styledText}`
          out.push(truncateToWidth(line, width, viewEllipsis()))
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
        : [
            p.following
              ? "end"
              : `${p.top + 1}${glyphs.rangeSeparator}${Math.min(p.total, p.top + p.height)} of ${p.total}`,
          ]
    const scroll = ["pageup", "pagedown", "home", "end"].map((name) => keyLabel({ name })).join(" ")
    const move = [glyphs.arrowUp, glyphs.arrowDown].join(
      glyphs.arrowUp.length === 1 && glyphs.arrowDown.length === 1 ? "" : "/",
    )
    // Narrow, whole items give way, the scroll keys first, so "esc close" stays.
    const hint = fitHint(
      [
        ...where.map((text) => ({ text, priority: 2 })),
        { text: `${move} ${scroll} scroll`, priority: 1 },
        {
          text: `${keyLabel({ name: "escape" })} ${this.#filtering ? "clear filter" : "close"}`,
          priority: 4,
        },
      ],
      Math.max(1, width - 2),
    )
    return `  ${styleHint(hint, theme)}`
  }
}
