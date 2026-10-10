import { RESET } from "../ansi.ts"
import { truncateToWidth, visibleWidth } from "../width.ts"
import type { Env } from "./blocks.ts"
import type { Run } from "./inline.ts"
import { type Cell, cellText, wrapCells } from "./layout.ts"

const pad = (n: number) => " ".repeat(Math.max(0, n))

/** A frame is useful only when it leaves at least four cells for code. */
function geometry(col: number, env: Env) {
  const side = visibleWidth(env.glyphs.codeSide)
  const framed = env.width - col - 2 * side - 1 >= 4
  // At tiny widths give back list indentation before sacrificing a wide code grapheme.
  const inset = framed ? col : Math.min(col, Math.max(0, env.width - 2))
  return { col: inset, width: Math.max(0, env.width - inset), framed }
}

/** A code surface fills the content width, leaving its list indent outside the background. */
function codeSurface(col: number, text: string, env: Env): string {
  const width = Math.max(0, env.width - col)
  const indent = pad(Math.min(col, env.width))
  if (!width) return indent
  const fit = truncateToWidth(text, width, "")
  const row = fit + pad(width - visibleWidth(fit))
  const bg = env.styles.codeBg
  if (!bg) return indent + row
  // Syntax styles and truncation may end with a full reset, not just a foreground close.
  const open = bg("\0").split("\0")[0]!
  return indent + bg(row.replaceAll(RESET, RESET + open))
}

/** A closed frame keeps its detection prefix, shortening only its language label to fit. */
export function frameRow(col: number, bottom: boolean, env: Env, lang = ""): string {
  const { glyphs } = env
  const box = geometry(col, env)
  if (!box.framed)
    return codeSurface(
      box.col,
      env.styles.codeFrame(bottom ? "" : truncateToWidth(lang, box.width, "…")),
      env,
    )
  const left = bottom ? glyphs.codeBottom : glyphs.codeTop
  const right = bottom ? glyphs.boxBottomRight : glyphs.boxTopRight
  const room = box.width - visibleWidth(left) - visibleWidth(right)
  const label = truncateToWidth(!bottom && lang ? ` ${lang}` : "", room, "…")
  const fill = room - visibleWidth(label)
  const ruleWidth = Math.max(1, visibleWidth(glyphs.rule))
  const rule = glyphs.rule.repeat(Math.floor(fill / ruleWidth)) + pad(fill % ruleWidth)
  return codeSurface(box.col, env.styles.codeFrame(left + label + rule + right), env)
}

/** Wrapping shares one geometry with frame rows; unframed fallback spends every cell on code. */
export function codeRows(col: number, cells: Cell[], runs: Run[], env: Env) {
  const box = geometry(col, env)
  const side = box.framed ? env.styles.codeFrame(env.glyphs.codeSide) : ""
  const gutter = box.framed ? `${side} ` : ""
  const room = Math.max(1, box.width - visibleWidth(gutter) - visibleWidth(side))
  const layout = wrapCells(cells, room, false)
  const rows = layout.map((r) => {
    const text = truncateToWidth(cellText(cells, runs, r.start, r.end), room, "…")
    return codeSurface(box.col, gutter + text + pad(room - visibleWidth(text)) + side, env)
  })
  return { rows, layout }
}
