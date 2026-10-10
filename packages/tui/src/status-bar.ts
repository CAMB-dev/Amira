import type { StatusTone } from "@amira/api"
import type { ResolvedStatusItem } from "@amira/core"
import {
  type RenderContext,
  type StyleFn,
  type Theme,
  themeToken,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"

/**
 * One item of the status: what extensions registered, or the UI's own (the input's hidden
 * rows). Higher `priority` stays longer when the line is too narrow; of equals, the later one
 * goes first.
 */
export type StatusEntry = ResolvedStatusItem

const separator = () => ` ${glyphs.separator} `

/** Fewest cells a lone item is cut to (its start and "…"); with less room it is left out. */
const MIN_CUT = 4

function toneStyle(tone: StatusTone, theme: Theme): StyleFn {
  switch (tone) {
    case "muted":
      return theme.muted
    case "accent":
      return theme.accent
    case "success":
      return theme.success
    case "warning":
      return theme.warning
    case "error":
      return theme.error
    default:
      return theme.text
  }
}

/** Cells a side takes: its texts and the separators between them; 0 when it is empty. */
const sideWidth = (xs: readonly StatusEntry[]) =>
  xs.reduce((n, x, i) => n + visibleWidth(x.text) + (i ? visibleWidth(separator()) : 0), 0)

/**
 * The items that fit, in their order: while `fits` says no, the item with the lowest priority
 * goes (of equals, the later one). A lone item still too wide is cut to `room(item)` cells.
 */
function fitItems(
  items: readonly StatusEntry[],
  fits: (left: number, right: number) => boolean,
  room: (item: StatusEntry) => number,
): { left: StatusEntry[]; right: StatusEntry[] } {
  const kept = [...items]
  const measure = () =>
    fits(
      sideWidth(kept.filter((i) => i.align === "left")),
      sideWidth(kept.filter((i) => i.align === "right")),
    )
  while (kept.length > 1 && !measure()) {
    let drop = 0
    for (let i = 1; i < kept.length; i++) if (kept[i]!.priority <= kept[drop]!.priority) drop = i
    kept.splice(drop, 1)
  }
  if (kept.length === 1 && !measure()) {
    // Cut, when a few characters are left to read; else left out.
    const cells = room(kept[0]!)
    if (cells >= MIN_CUT) kept[0] = { ...kept[0]!, text: truncateToWidth(kept[0]!.text, cells, glyphs.more) }
    else kept.length = 0
  }
  return { left: kept.filter((i) => i.align === "left"), right: kept.filter((i) => i.align === "right") }
}

function join(xs: readonly StatusEntry[], theme: Theme): string {
  const dim = themeToken(theme, "dim") ?? theme.muted
  return xs.map((x) => toneStyle(x.tone, theme)(x.text)).join(dim(separator()))
}

/**
 * The bottom border of the input box with the status in it: `╰─ left ───── right ─╯`, left
 * items after the corner, right ones against the other, the border filled in between. Items
 * that do not fit go, lowest priority first; the border keeps its corners and is always
 * exactly `width` cells (at least 6).
 */
export function statusBorder(items: readonly StatusEntry[], width: number, ctx: RenderContext): string {
  const { theme } = ctx
  const line = theme.border
  // "╰─" and "─╯", a space on each side of a group, and "─" between: at least three between
  // two groups, so they read apart.
  const fits = (l: number, r: number) => 2 + (l ? l + 2 : 0) + (l && r ? 3 : 1) + (r ? r + 2 : 0) + 2 <= width
  const { left, right } = fitItems(items, fits, () => width - 7)
  const l = sideWidth(left)
  const r = sideWidth(right)
  const fill = width - 4 - (l ? l + 2 : 0) - (r ? r + 2 : 0)
  const bottomLeft = ctx.glyphs?.boxBottomLeft ?? "╰"
  const bottomRight = ctx.glyphs?.boxBottomRight ?? "╯"
  if (fill < 1) return line(`${bottomLeft}${glyphs.rule.repeat(Math.max(0, width - 2))}${bottomRight}`)
  return (
    line(`${bottomLeft}${glyphs.rule}`) +
    (l ? ` ${join(left, theme)} ` : "") +
    line(glyphs.rule.repeat(fill)) +
    (r ? ` ${join(right, theme)} ` : "") +
    line(`${glyphs.rule}${bottomRight}`)
  )
}

/**
 * The status as a line of its own, where no input box is there to carry it (a dialog has the
 * input's place): left items from the left edge, right items against the right edge. Empty
 * without items.
 */
export function statusLine(items: readonly StatusEntry[], width: number, ctx: RenderContext): string[] {
  const fits = (l: number, r: number) => l + r + (l && r ? 2 : 0) <= width
  const { left, right } = fitItems(items, fits, () => width)
  if (!left.length && !right.length) return []
  if (!right.length) return [join(left, ctx.theme)]
  const gap = width - sideWidth(left) - sideWidth(right)
  return [join(left, ctx.theme) + " ".repeat(Math.max(0, gap)) + join(right, ctx.theme)]
}
