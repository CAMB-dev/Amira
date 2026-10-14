import type { ViewSegment } from "@amira/api"
import { graphemes } from "@amira/tui-kit"

const animated = Symbol("animated view segment")
type AnimatedSegment = ViewSegment & { [animated]?: boolean }
// An OSC-8-shaped, zero-cell annotation survives string-based layout/clipping and color
// stripping without opening a link. Removed from the final frame before terminal output;
// extension text is sanitized before this host-only provenance is added.
const marker = "\x1b]8;id=amira-view-animation;\x07"

export function animatedSegments(parts: ViewSegment[]): ViewSegment[] {
  return parts.map((part) => ({ ...part, [animated]: true }))
}

/** Place provenance after the first glyph, so a horizontally clipped badge cannot demand ticks. */
export function animationText(part: ViewSegment, text: string): string {
  if (!(part as AnimatedSegment)[animated]) return text
  const first = graphemes(text)[0]
  return first ? first + marker + text.slice(first.length) : text
}

/** Only provenance surviving the final viewport contributes automatic animation demand. */
export function visibleAnimation(rows: string[]): { rows: string[]; animating: boolean } {
  return {
    animating: rows.some((row) => row.includes(marker)),
    rows: rows.map((row) => row.replaceAll(marker, "")),
  }
}
