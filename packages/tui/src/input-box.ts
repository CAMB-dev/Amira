import { Box, type Component, type Editor, type RenderContext } from "@amira/tui-kit"

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
 * The editor in a rounded frame. Longer text scrolls inside it; the border says how many
 * rows are out of view above and below.
 */
export class InputBox implements Component {
  private box: Box

  constructor(private editor: Editor) {
    this.box = new Box(editor, {
      labels: () => {
        const { above, below } = this.editor.hidden
        return {
          ...(above > 0 ? { top: `↑ ${above} more` } : {}),
          ...(below > 0 ? { bottom: `↓ ${below} more` } : {}),
        }
      },
    })
  }

  render(width: number, ctx: RenderContext): string[] {
    this.editor.maxRows = inputRows(ctx.rows)
    return this.box.render(width, ctx)
  }
}
