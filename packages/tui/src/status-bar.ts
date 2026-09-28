import type { StatusTone } from "@amira/api"
import type { ResolvedStatusItem } from "@amira/core"
import {
  type Component,
  type RenderContext,
  type StyleFn,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"

const SEPARATOR = " · "

function toneStyle(tone: StatusTone, ctx: RenderContext): StyleFn {
  switch (tone) {
    case "muted":
      return ctx.theme.muted
    case "accent":
      return ctx.theme.accent
    case "success":
      return ctx.theme.success
    case "warning":
      return ctx.theme.warning
    case "error":
      return ctx.theme.error
    default:
      return ctx.theme.text
  }
}

/**
 * The status bar slot. It shows whatever extensions registered (D47): left items
 * from the left edge, right items against the right edge, dropping right items first
 * when the line is too narrow.
 */
export class StatusBar implements Component {
  constructor(private items: () => ResolvedStatusItem[]) {}

  render(width: number, ctx: RenderContext): string[] {
    const items = this.items()
    if (items.length === 0) return []
    const join = (xs: ResolvedStatusItem[]) =>
      xs.map((i) => toneStyle(i.tone, ctx)(i.text)).join(ctx.theme.muted(SEPARATOR))
    const left = join(items.filter((i) => i.align === "left"))
    let rightItems = items.filter((i) => i.align === "right")
    let right = join(rightItems)
    while (rightItems.length && visibleWidth(left) + 2 + visibleWidth(right) > width) {
      rightItems = rightItems.slice(1)
      right = join(rightItems)
    }
    const gap = width - visibleWidth(left) - visibleWidth(right)
    if (!right || gap < 2) return [truncateToWidth(left || right, width)]
    return [left + " ".repeat(gap) + right]
  }
}
