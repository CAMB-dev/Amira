import {
  Box,
  bold,
  type Component,
  compose,
  type Editor,
  type RenderContext,
  type Theme,
  themeToken,
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
  private input: Component
  private box: Box

  constructor(
    private editor: Editor,
    private status: () => readonly StatusEntry[] = () => [],
  ) {
    this.input = {
      render: (width, ctx) => {
        if (!ctx.color || !editor.focused) return editor.render(width, ctx)
        let theme = inputThemes.get(ctx.theme)
        if (!theme) {
          theme = { ...ctx.theme, accent: compose(bold, ctx.theme.accent) }
          inputThemes.set(ctx.theme, theme)
        }
        return editor.render(width, { ...ctx, theme })
      },
    }
    this.box = new Box(this.input, {
      markerGutter: true,
      labels: () => {
        const { above } = this.editor.hidden
        return above > 0 ? { top: `↑ ${above} ${above === 1 ? "row" : "rows"}` } : {}
      },
    })
  }

  render(width: number, ctx: RenderContext): string[] {
    const framed = width >= 8 && this.maxRows >= 4
    const chrome = width < 8 ? 0 : (framed ? 2 : 0) + (this.maxRows >= 2 ? 1 : 0)
    this.editor.maxRows = Math.min(inputRows(ctx.rows), Math.max(1, this.maxRows - chrome))
    const border = this.editor.focused ? themeToken(ctx.theme, "borderFocused") : undefined
    let theme = ctx.theme
    if (border) {
      theme = focusedThemes.get(ctx.theme) ?? { ...ctx.theme, border }
      focusedThemes.set(ctx.theme, theme)
    }
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
            text: `↓ ${below} ${below === 1 ? "row" : "rows"}`,
          },
        ]
      : []
    return [...rows, ...statusLine([...this.status(), ...more], width, ctx)]
  }
}
