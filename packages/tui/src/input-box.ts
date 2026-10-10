import { Box, type Component, type Editor, type RenderContext, type Theme, themeToken } from "@amira/tui-kit"
import { type StatusEntry, statusBorder } from "./status-bar.ts"

const focusedThemes = new WeakMap<Theme, Theme>()

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
 * The editor in a rounded frame, with the status in its bottom border. Longer text scrolls
 * inside it; the border says how many rows are out of view above and below (the rows below at
 * the right end of the status, which gives way before that count does).
 */
export class InputBox implements Component {
  private box: Box

  constructor(
    private editor: Editor,
    status: () => readonly StatusEntry[] = () => [],
  ) {
    this.box = new Box(editor, {
      labels: () => {
        const { above } = this.editor.hidden
        return above > 0 ? { top: `↑ ${above} ${above === 1 ? "row" : "rows"}` } : {}
      },
      bottom: (width, ctx) => {
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
        return statusBorder([...status(), ...more], width, ctx)
      },
    })
  }

  render(width: number, ctx: RenderContext): string[] {
    this.editor.maxRows = inputRows(ctx.rows)
    const border = this.editor.focused ? themeToken(ctx.theme, "borderFocused") : undefined
    if (!border) return this.box.render(width, ctx)
    let theme = focusedThemes.get(ctx.theme)
    if (!theme) {
      theme = { ...ctx.theme, border }
      focusedThemes.set(ctx.theme, theme)
    }
    return this.box.render(width, { ...ctx, theme })
  }
}
