import type { Size } from "@amira/api"
import { closeStyles, truncateToWidth, visibleWidth } from "@amira/tui-kit"

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const cells = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0)

/** Integer allocation. Percentages use the budget after gaps; overflow shrinks proportionally. */
export function allocate(
  total: number,
  children: readonly { size?: Size; min?: number }[],
  gap = 0,
  divider = false,
): number[] {
  const room = Math.max(0, cells(total) - Math.max(0, children.length - 1) * (cells(gap) + +divider))
  const desired = children.map(({ size, min }) => {
    const request =
      typeof size === "number"
        ? cells(size)
        : size?.endsWith("%")
          ? (room * Number.parseFloat(size)) / 100
          : 0
    return Math.max(cells(min ?? 0), Number.isFinite(request) ? Math.max(0, request) : 0)
  })
  const demand = desired.reduce((sum, size) => sum + size, 0)
  const minima = children.map((c) => cells(c.min ?? 0))
  const minimum = minima.reduce((sum, size) => sum + size, 0)
  // Reserve feasible minima; only the demand above them competes for remaining cells.
  const raw =
    minimum > room
      ? minima.map((size) => (size * room) / minimum)
      : demand > room
        ? desired.map((size, i) => minima[i]! + ((size - minima[i]!) * (room - minimum)) / (demand - minimum))
        : desired
  const sizes = raw.map(Math.floor)
  let rounding = Math.min(room, Math.floor(demand)) - sizes.reduce((sum, size) => sum + size, 0)
  for (let i = 0; i < sizes.length && rounding > 0; i++) {
    if (raw[i]! > sizes[i]!) {
      sizes[i]!++
      rounding--
    }
  }
  const used = sizes.reduce((sum, size) => sum + size, 0)
  if (demand <= room) {
    const fill = children.flatMap((c, i) => (c.size === undefined || c.size === "fill" ? [i] : []))
    const each = Math.floor((room - used) / (fill.length || 1))
    let extra = (room - used) % (fill.length || 1)
    for (const i of fill) sizes[i]! += each + (extra-- > 0 ? 1 : 0)
  }
  return sizes
}

/** A styled string clipped with ellipsis and padded, without leaking styles into a neighbor. */
export function fit(text: string, width: number, right = false): string {
  if (width <= 0) return ""
  const cut = closeStyles(truncateToWidth(text, width, "…"))
  const pad = " ".repeat(Math.max(0, width - visibleWidth(cut)))
  return right ? pad + cut : cut + pad
}

export function sides(left: string, right: string, width: number): string {
  if (!right) return fit(left, width)
  const rw = Math.min(width, visibleWidth(right))
  return fit(left, Math.max(0, width - rw - 1)) + (rw < width ? " " : "") + fit(right, rw)
}

export function inside(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height
}
