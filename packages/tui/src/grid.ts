import { truncateToWidth, visibleWidth } from "@amira/tui-kit"

/** Local columns inside tui.margin: a marker and its gap, then all readable text. */
export const MARKER_WIDTH = 2
export const CONTENT_INSET = " ".repeat(MARKER_WIDTH)

export const contentRoom = (width: number): number => Math.max(1, width - MARKER_WIDTH)

/** Wide warning/ASCII tree glyphs consume the gap rather than shifting the content. */
export function markerPrefix(marker: string): string {
  const fit = truncateToWidth(marker, MARKER_WIDTH, "")
  return fit + " ".repeat(Math.max(0, MARKER_WIDTH - visibleWidth(fit)))
}
