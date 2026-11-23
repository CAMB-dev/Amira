import type { ViewSegment } from "@amira/api"
import { graphemes, Spinner } from "@amira/tui-kit"
import { SHIMMER_INTERVAL_MS } from "./app/shimmer.ts"

export const ELAPSED_INTERVAL_MS = 1000

export type AnimationCadence = "shimmer" | "spinner" | "elapsed"

const animated = Symbol("animated view segment")
type AnimatedSegment = ViewSegment & { [animated]?: boolean }
// OSC-8-shaped, zero-cell annotations survive string-based layout/clipping and color
// stripping without opening a link. Removed from the final frame before terminal output;
// extension text is sanitized before this host-only provenance is added.
const MARKERS: Record<AnimationCadence, { marker: string; intervalMs: number }> = {
  shimmer: { marker: "\x1b]8;id=amira-view-animation-shimmer;\x07", intervalMs: SHIMMER_INTERVAL_MS },
  spinner: { marker: "\x1b]8;id=amira-view-animation;\x07", intervalMs: Spinner.INTERVAL_MS },
  elapsed: { marker: "\x1b]8;id=amira-view-animation-elapsed;\x07", intervalMs: ELAPSED_INTERVAL_MS },
}
const CADENCES = Object.values(MARKERS)

// biome-ignore lint/suspicious/noControlCharactersInRegex: stepping past leading SGR codes
const LEADING_SGR = /^(?:\x1b\[[0-9;:]*m)+/

export function animatedSegments<T extends ViewSegment>(parts: T[]): T[] {
  return parts.map((part) => ({ ...part, [animated]: true }))
}

/** Place provenance after the first visible glyph, so a horizontally clipped segment cannot demand ticks. */
export function markAnimated(text: string, cadence: AnimationCadence = "spinner"): string {
  const lead = LEADING_SGR.exec(text)?.[0] ?? ""
  const rest = text.slice(lead.length)
  const first = graphemes(rest)[0]
  return first ? lead + first + MARKERS[cadence].marker + rest.slice(first.length) : text
}

/** Place provenance after the first glyph for legacy symbol-marked segments. */
export function animationText(part: ViewSegment, text: string): string {
  return (part as AnimatedSegment)[animated] ? markAnimated(text, "spinner") : text
}

/** Only provenance surviving the final viewport contributes automatic animation demand. */
export function visibleAnimation(rows: string[]): {
  rows: string[]
  animating: boolean
  refreshIntervalMs: number | undefined
} {
  let refreshIntervalMs: number | undefined
  for (const { marker, intervalMs } of CADENCES) {
    if (rows.some((row) => row.includes(marker))) {
      refreshIntervalMs = Math.min(refreshIntervalMs ?? Infinity, intervalMs)
    }
  }
  const clean =
    refreshIntervalMs === undefined
      ? rows
      : rows.map((row) => {
          let out = row
          for (const { marker } of CADENCES) out = out.replaceAll(marker, "")
          return out
        })
  return {
    rows: clean,
    animating: refreshIntervalMs !== undefined && refreshIntervalMs <= Spinner.INTERVAL_MS,
    refreshIntervalMs,
  }
}
