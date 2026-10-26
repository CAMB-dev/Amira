import { closeStyles, type RenderContext, type StyleFn, truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { glyphs, viewEllipsis } from "./glyphs.ts"

/**
 * Shared dialog frame: an intact perimeter, the title set off by rules ("╭─ Title ─╮") and one
 * padding cell inside each side; body rows carry their own cursor/marker column.
 */
export function dialogFrame(
  title: string,
  body: readonly string[],
  width: number,
  ctx: RenderContext,
  border: StyleFn = ctx.theme.accent,
  maxRows = Number.POSITIVE_INFINITY,
): string[] {
  // Below four rows there is not room for title, choice, hint AND both edges.
  // Use the compact bare fallback rather than drawing a broken partial perimeter.
  if (width < 6 || maxRows < 4) {
    return [title, ...body].map((row) => truncateToWidth(row, width)).slice(-Math.max(1, maxRows))
  }
  const inner = Math.max(1, width - 4)
  const label = truncateToWidth(title, Math.max(0, width - 6), viewEllipsis())
  const top =
    border(`${glyphs.boxTopLeft}${glyphs.rule} `) +
    label +
    border(` ${glyphs.rule.repeat(Math.max(0, width - 5 - visibleWidth(label)))}${glyphs.boxTopRight}`)
  const side = ctx.glyphs?.codeSide ?? "│"
  const room = Math.max(0, maxRows - 2)
  const kept = body.length <= room ? body : [...body.slice(0, room - 1), body.at(-1)!]
  return [
    top,
    ...kept.map((line) => {
      const fit = closeStyles(truncateToWidth(line, inner, viewEllipsis()))
      return `${border(side)} ${fit}${" ".repeat(Math.max(0, inner - visibleWidth(fit)))} ${border(side)}`
    }),
    border(`${glyphs.boxBottomLeft}${glyphs.rule.repeat(width - 2)}${glyphs.boxBottomRight}`),
  ]
}
