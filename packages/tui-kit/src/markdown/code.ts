import { RESET } from "../ansi.ts"
import { truncateToWidth, visibleWidth } from "../width.ts"
import type { Env } from "./blocks.ts"
import type { Run } from "./inline.ts"
import { type Cell, cellText, wrapCells } from "./layout.ts"

const pad = (n: number) => " ".repeat(Math.max(0, n))

/** At tiny widths give back list indentation before sacrificing a wide code grapheme. */
function geometry(col: number, env: Env) {
  const inset = Math.min(col, Math.max(0, env.width - 2))
  return { col: inset, width: Math.max(0, env.width - inset) }
}

/** Code is a reading surface, not a bordered input. List indentation remains outside it. */
function codeSurface(col: number, text: string, env: Env): string {
  const width = Math.max(0, env.width - col)
  const indent = pad(Math.min(col, env.width))
  if (!width) return indent
  const fit = truncateToWidth(text, width, "")
  const row = fit + pad(width - visibleWidth(fit))
  const bg = env.styles.codeBg
  if (!bg) return indent + row
  const open = bg("\0").split("\0")[0]!
  return indent + bg(row.replaceAll(RESET, RESET + open))
}

/** Blank surface edges, with the muted language tucked into the top-right. */
export function frameRow(col: number, bottom: boolean, env: Env, lang = ""): string {
  const box = geometry(col, env)
  const label = bottom ? "" : truncateToWidth(lang, box.width, "…")
  const row = codeSurface(box.col, pad(box.width - visibleWidth(label)) + env.styles.codeFrame(label), env)
  env.codeRow?.(row, bottom ? "bottom" : "top", box.col)
  return row
}

/** Code uses every content cell and wraps without a second gutter. */
export function codeRows(col: number, cells: Cell[], runs: Run[], env: Env) {
  const box = geometry(col, env)
  const room = Math.max(1, box.width)
  const layout = wrapCells(cells, room, false)
  const rows = layout.map((r) => {
    const text = truncateToWidth(cellText(cells, runs, r.start, r.end), room, "…")
    const row = codeSurface(box.col, text + pad(room - visibleWidth(text)), env)
    env.codeRow?.(row, "body", box.col)
    return row
  })
  return { rows, layout }
}
