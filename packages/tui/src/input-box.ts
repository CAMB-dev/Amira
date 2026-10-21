import {
  Box,
  bold,
  type Component,
  CURSOR_MARKER,
  chromeGlyphs,
  compose,
  type Editor,
  type RenderContext,
  type Theme,
  themeToken,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import { type StatusEntry, statusLine } from "./status-bar.ts"

const focusedThemes = new WeakMap<Theme, Theme>()
const inputThemes = new WeakMap<Theme, Theme>()

/** Most rows of text the input box shows before it scrolls. */
export const MAX_INPUT_ROWS = 10

/**
 * Rows of text the input box shows on a terminal `rows` high: a third of it, up to
 * MAX_INPUT_ROWS, and at least one, so the box stays at the bottom and leaves room above.
 */
export function inputRows(rows: number): number {
  return Math.max(1, Math.min(MAX_INPUT_ROWS, Math.floor(rows / 3)))
}

/**
 * The editor in an intact rounded frame, with status on a separate shared-edge row below.
 * Longer text scrolls inside it; hidden rows above label the top edge and hidden rows below
 * stay at the right of the status, outlasting lower-priority items.
 */
export class InputBox implements Component {
  /** Total composer rows, including its edges and separate status. */
  maxRows = Number.POSITIVE_INFINITY
  /** Distinguish the composer from an adjacent extension view using the accent role. */
  accentFocus = false
  private input: Component
  private box: Box
  private arrowUp = chromeGlyphs().arrowUp

  constructor(
    private editor: Editor,
    private status: () => readonly StatusEntry[] = () => [],
    private suggestion: () => string | undefined = () => undefined,
  ) {
    this.input = {
      render: (width, ctx) => {
        let theme = ctx.theme
        if (ctx.color && editor.focused) {
          theme = inputThemes.get(ctx.theme) ?? { ...ctx.theme, accent: compose(bold, ctx.theme.accent) }
          inputThemes.set(ctx.theme, theme)
        }
        const rows = editor.render(width, { ...ctx, theme })
        const suggestion = editor.focused && editor.isEmpty ? this.suggestion() : undefined
        if (suggestion) {
          // Preserve the editor's prompt and cursor, replacing only its empty-input placeholder.
          const row = rows[0]!
          const at = row.indexOf(CURSOR_MARKER) + CURSOR_MARKER.length
          const prefix = row.slice(0, at)
          const room = Math.max(0, width - visibleWidth(prefix))
          rows[0] = prefix + ctx.theme.dim(truncateToWidth(suggestion, room, chromeGlyphs(ctx.glyphs).more))
        }
        return rows
      },
    }
    this.box = new Box(this.input, {
      labels: () => {
        const { above } = this.editor.hidden
        return above > 0 ? { top: `${this.arrowUp} ${above} ${above === 1 ? "row" : "rows"}` } : {}
      },
    })
  }

  /** Whether the composer has room for its frame and side padding. */
  framed(width: number): boolean {
    return width >= 8 && this.maxRows >= 4
  }

  render(width: number, ctx: RenderContext): string[] {
    const arrows = chromeGlyphs(ctx.glyphs)
    this.arrowUp = arrows.arrowUp
    const framed = this.framed(width)
    const chrome = width < 8 ? 0 : (framed ? 2 : 0) + (this.maxRows >= 2 ? 1 : 0)
    this.editor.maxRows = Math.min(inputRows(ctx.rows), Math.max(1, this.maxRows - chrome))
    const border = themeToken(ctx.theme, "borderFocused") ?? ctx.theme.accent
    let theme: Theme
    if (this.editor.focused) {
      if (this.accentFocus) theme = { ...ctx.theme, border: ctx.theme.accent }
      else {
        theme = focusedThemes.get(ctx.theme) ?? { ...ctx.theme, border }
        focusedThemes.set(ctx.theme, theme)
      }
    } else theme = { ...ctx.theme, border: ctx.theme.muted }
    const rows = (framed ? this.box : this.input).render(width, { ...ctx, theme })
    if (width < 8 || this.maxRows < 2) return rows
    const { below } = this.editor.hidden
    const more: StatusEntry[] = below
      ? [
          {
            id: "input.below",
            align: "right",
            tone: "muted",
            priority: Number.POSITIVE_INFINITY,
            text: `${arrows.arrowDown} ${below} ${below === 1 ? "row" : "rows"}`,
          },
        ]
      : []
    return [...rows, ...statusLine([...this.status(), ...more], width, ctx)]
  }
}
