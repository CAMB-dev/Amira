import type { Component, RenderContext } from "../component.ts"
import { closeStyles, truncateToWidth, visibleWidth } from "../width.ts"

export interface BoxOptions {
  /** Short texts drawn into the top and bottom border, against the right corner. */
  labels?: () => { top?: string; bottom?: string }
  /**
   * Draws the bottom border in place of the plain one (and its label), e.g. with a status in
   * it; it must return exactly `width` cells.
   */
  bottom?: (width: number, ctx: RenderContext) => string
}

/** Below this width a border would leave the child almost no room; it is drawn bare instead. */
const MIN_WIDTH = 8

/**
 * Draws a rounded border in the theme's `border` color around a child, spanning the full width
 * with one cell of padding on each side. The child renders at the inner width; a caret it marks
 * stays where it is, shifted by the border. Too narrow for a border, the child is drawn alone.
 */
export class Box implements Component {
  constructor(
    private child: Component,
    private opts: BoxOptions = {},
  ) {}

  render(width: number, ctx: RenderContext): string[] {
    if (width < MIN_WIDTH) return this.child.render(width, ctx)
    const border = ctx.theme.border
    const inner = width - 4
    const side = border("│")
    const rows = this.child.render(inner, ctx).map((line) => {
      // Closed, so the child's styles cannot reach the padding or the border.
      const fitted = closeStyles(truncateToWidth(line, inner))
      return `${side} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${side}`
    })
    const labels = this.opts.labels?.() ?? {}
    const bottom = this.opts.bottom?.(width, ctx) ?? edge("╰", "╯", labels.bottom, width, ctx)
    return [edge("╭", "╮", labels.top, width, ctx), ...rows, bottom]
  }
}

/** A horizontal border with its corners, and a label near the right corner when it fits. */
function edge(left: string, right: string, label: string | undefined, width: number, ctx: RenderContext) {
  const border = ctx.theme.border
  const text = label ? ` ${label} ` : ""
  const room = width - 2 - visibleWidth(text) - 1
  if (text && room >= 1) {
    return border(`${left}${"─".repeat(room)}`) + ctx.theme.muted(text) + border(`─${right}`)
  }
  return border(`${left}${"─".repeat(width - 2)}${right}`)
}
