import {
  closeStyles,
  type RenderContext,
  type StyleFn,
  stripAnsi,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"

/** Shared typing frame: an intact perimeter, an interior marker gutter and a separate footer. */
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
  if (width < 5 || maxRows < 4) {
    return [title, ...body].map((row) => truncateToWidth(row, width)).slice(-Math.max(1, maxRows))
  }
  const inner = Math.max(1, width - 3)
  const label = truncateToWidth(title, inner, glyphs.more)
  const top =
    border(`${glyphs.boxTopLeft} `) +
    label +
    border(glyphs.rule.repeat(Math.max(0, inner - visibleWidth(label))) + glyphs.boxTopRight)
  const side = ctx.glyphs?.codeSide ?? "│"
  const markers = [glyphs.pointer, glyphs.choice, glyphs.user].map((glyph) => `${glyph} `)
  const room = Math.max(0, maxRows - 2)
  const kept = body.length <= room ? body : [...body.slice(0, room - 1), body.at(-1)!]
  const rows = kept.map((line) => {
    const plain = stripAnsi(line)
    const marked = markers.some((marker) => plain.startsWith(marker))
    // The border occupies gutter cell zero. Cursor cell one abuts content cell two;
    // unmarked rows keep one interior padding cell. Preserve all ANSI/caret tokens.
    const content = marked ? omitCells(line, 1, 1) : plain.startsWith("  ") ? omitCells(line, 0, 2) : line
    const prefix = marked ? "" : " "
    const cells = inner + (marked ? 1 : 0)
    const fit = closeStyles(truncateToWidth(content, cells, glyphs.more))
    return border(side) + prefix + fit + " ".repeat(Math.max(0, cells - visibleWidth(fit))) + border(side)
  })
  return [
    top,
    ...rows,
    border(`${glyphs.boxBottomLeft}${glyphs.rule.repeat(width - 2)}${glyphs.boxBottomRight}`),
  ]
}

/** Remove only visible gutter cells; styling sequences and zero-width cursor markers survive. */
function omitCells(line: string, from: number, count: number): string {
  let column = 0
  let out = ""
  for (let at = 0; at < line.length; ) {
    if (line[at] === "\x1b") {
      let end = at + 2
      if (line[at + 1] === "[") {
        while (end < line.length && /[0-? -/]/.test(line[end]!)) end++
        end++
      } else if ("]P_^X".includes(line[at + 1] ?? "")) {
        while (end < line.length && line[end] !== "\x07" && !line.startsWith("\x1b\\", end)) end++
        end += line[end] === "\x07" ? 1 : 2
      }
      out += line.slice(at, end)
      at = end
      continue
    }
    const cell = String.fromCodePoint(line.codePointAt(at)!)
    if (column < from || column >= from + count) out += cell
    column += visibleWidth(cell)
    at += cell.length
    if (column >= from + count) return out + line.slice(at)
  }
  return out
}
