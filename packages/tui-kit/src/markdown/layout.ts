import { graphemes } from "../width.ts"
import type { Run } from "./inline.ts"

/** One grapheme of rendered text and where it came from. */
export interface Cell {
  g: string
  width: number
  /** Index of its run. */
  run: number
  /** Offset of the grapheme in the parsed source. */
  src: number
}

/** A wrapped row: cells `[start, end)`; the next row starts at cell `next`. */
export interface Row {
  start: number
  end: number
  next: number
  /**
   * Whether text added after the source can no longer change the row: the cell that pushed it
   * to the next row is not the last one, since that one may still grow (a combining mark).
   */
  stable: boolean
}

export function toCells(runs: Run[]): Cell[] {
  const cells: Cell[] = []
  runs.forEach((r, i) => {
    let src = r.src
    for (const g of graphemes(r.text)) {
      cells.push({ g, width: Bun.stringWidth(g), run: i, src })
      src += g.length
    }
  })
  return cells
}

/**
 * Wraps cells to `width`. With `words`, breaks after a space (which is dropped) or a wide
 * character and hard-breaks longer words, like `wrapText`; otherwise breaks exactly at the
 * width, as code is shown. Each row is laid out from where it starts, never from earlier rows,
 * so dropping the rows before one leaves it unchanged.
 */
export function wrapCells(cells: Cell[], width: number, words: boolean): Row[] {
  const rows: Row[] = []
  const max = Math.max(1, width)
  let start = 0
  let used = 0
  let breakEnd = -1
  let breakNext = -1
  for (let j = 0; j < cells.length; j++) {
    const c = cells[j]!
    if (used + c.width > max && j > start) {
      let end = j
      let next = j
      if (words && c.g === " ") next = j + 1
      else if (words && breakEnd > start) {
        end = breakEnd
        next = breakNext
      }
      rows.push({ start, end, next, stable: j < cells.length - 1 })
      start = next
      used = 0
      breakEnd = -1
      // Lay out again from the new row's start, as if it were the first.
      j = next - 1
      continue
    }
    used += c.width
    if (!words) continue
    if (c.g === " ") {
      breakEnd = j
      breakNext = j + 1
    } else if (c.width === 2) {
      breakEnd = j + 1
      breakNext = j + 1
    }
  }
  if (start < cells.length || rows.length === 0) {
    rows.push({ start, end: cells.length, next: cells.length, stable: false })
  }
  return rows
}

const LINK_CLOSE = "\x1b]8;;\x07"

/** The styled text of cells `[start, end)`, each style and link closed within it. */
export function cellText(cells: Cell[], runs: Run[], start: number, end: number): string {
  let out = ""
  let i = start
  while (i < end) {
    const r = cells[i]!.run
    let text = ""
    while (i < end && cells[i]!.run === r) text += cells[i++]!.g
    const run = runs[r]!
    if (run.link) text = `\x1b]8;;${run.link}\x07${text}${LINK_CLOSE}`
    out += run.style ? run.style(text) : text
  }
  return out
}
