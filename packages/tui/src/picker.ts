import { type Theme, truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"

/** Rows of items shown at once; the list scrolls to keep the selection visible. */
export const PICKER_ROWS = 8

/** How an item reads in the list. */
export interface PickerRow {
  label: string
  description?: string
}

/** Draws list rows like the command popup does. */
export function pickerRows(rows: PickerRow[], selected: number, width: number, theme: Theme): string[] {
  const n = rows.length
  const start = Math.min(Math.max(0, selected - PICKER_ROWS + 1), Math.max(0, n - PICKER_ROWS))
  const shown = rows.slice(start, start + PICKER_ROWS)
  const col = Math.min(32, Math.max(...shown.map((r) => visibleWidth(r.label))))
  const lines = shown.map((r, i) => {
    const pad = r.description ? " ".repeat(Math.max(0, col - visibleWidth(r.label))) : ""
    const desc = r.description ? `  ${theme.muted(r.description)}` : ""
    const line =
      start + i === selected
        ? `${theme.accent(glyphs.pointer)} ${theme.accent(r.label)}${pad}${desc}`
        : `  ${r.label}${pad}${desc}`
    return truncateToWidth(line, width, "…")
  })
  if (n > PICKER_ROWS) lines.push(theme.muted(`  ${selected + 1}/${n}`))
  return lines
}
