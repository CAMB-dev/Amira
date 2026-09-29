import type { CellSize, Fit } from "./types.ts"

export type { CellSize, Fit }

/** Sixel draws in bands of six pixel rows; a partial last band still moves by six. */
const BAND = 6

const rowsFor = (height: number, cell: CellSize) => Math.ceil((Math.ceil(height / BAND) * BAND) / cell.height)

/**
 * Scales an image of `width`×`height` pixels down (never up) to fit `maxCols`×`maxRows` cells of
 * `cell` pixels, keeping its aspect ratio, and says how many cells it then covers. The rows are
 * counted as Sixel draws them (the height rounded up to a whole band), so a renderer that
 * reserves `rows` rows has room for any protocol. Undefined when nothing fits.
 */
export function fitImage(
  size: { width: number; height: number },
  maxCols: number,
  maxRows: number,
  cell: CellSize,
): Fit | undefined {
  if (maxCols < 1 || maxRows < 1 || size.width < 1 || size.height < 1) return undefined
  const scale = Math.min(1, (maxCols * cell.width) / size.width, (maxRows * cell.height) / size.height)
  let width = Math.max(1, Math.floor(size.width * scale))
  let height = Math.max(1, Math.floor(size.height * scale))
  const rows = Math.ceil(height / cell.height)
  if (rowsFor(height, cell) > rows) {
    // Its last band would reach into another row: a few pixels less keep it to whole bands.
    height = Math.floor((rows * cell.height) / BAND) * BAND
    if (height < 1) return undefined
    width = Math.max(1, Math.round((size.width * height) / size.height))
  }
  return { width, height, cols: Math.ceil(width / cell.width), rows: rowsFor(height, cell) }
}
