import { type Theme, truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"

/** Rows of items shown at once; the list scrolls to keep the selection visible. */
export const PICKER_ROWS = 8

/** How an item reads in the list. */
export interface PickerRow {
  label: string
  description?: string
}

/** The most of the width the label column takes when rows have descriptions. */
const LABEL_SHARE = 0.4

/**
 * Draws the rows of a completion list (commands, skills, files): ❯ before the selected one
 * (none while `selected` is -1), and descriptions in a column after the labels. The column is
 * as wide as the longest label of the whole list, so it stays put while the list scrolls, but
 * at most 40% of the width: a longer label is cut with "…" rather than pushing every
 * description out of view.
 */
export function pickerRows(rows: PickerRow[], selected: number, width: number, theme: Theme): string[] {
  const n = rows.length
  const at = Math.max(0, selected)
  const start = Math.min(Math.max(0, at - PICKER_ROWS + 1), Math.max(0, n - PICKER_ROWS))
  const shown = rows.slice(start, start + PICKER_ROWS)
  const described = rows.some((r) => r.description)
  const room = Math.max(8, Math.floor((width - 2) * LABEL_SHARE))
  const col = Math.min(room, Math.max(...rows.map((r) => visibleWidth(r.label))))
  const lines = shown.map((r, i) => {
    const label =
      described && visibleWidth(r.label) > col ? truncateToWidth(r.label, col, glyphs.more) : r.label
    const pad = r.description ? " ".repeat(Math.max(0, col - visibleWidth(label))) : ""
    const desc = r.description ? `  ${theme.muted(r.description)}` : ""
    const line =
      start + i === selected
        ? `${theme.accent(glyphs.choice)} ${theme.accent(label)}${pad}${desc}`
        : `  ${label}${pad}${desc}`
    return truncateToWidth(line, width, glyphs.more)
  })
  if (n > PICKER_ROWS) lines.push(theme.muted(`  ${at + 1}/${n}`))
  return lines
}
