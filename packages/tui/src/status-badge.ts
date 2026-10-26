import { AGENT_STATUS_BADGES, type AgentStatusState, type ViewSegment } from "@amira/api"
import { chromeGlyphs, Spinner, type Theme } from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"

const keys = {
  queued: "statusQueued",
  working: "statusWorking",
  idle: "statusIdle",
  paused: "statusPaused",
  done: "statusDone",
  failed: "statusFailed",
  stopped: "statusStopped",
} as const

/** A badge's symbol in the theme's glyphs; working turns with the given spinner frame. */
export function badgeSymbol(state: AgentStatusState, spinner = new Spinner().glyph): string {
  const badge = AGENT_STATUS_BADGES[state]
  const ascii = /^[\x20-\x7e]+$/.test(glyphs.pointer)
  const configured = glyphs[keys[state]]
  const symbol = ascii && configured === badge.symbol ? badge.ascii : configured
  if (state !== "working") return symbol
  return symbol === badge.symbol ? spinner : symbol === badge.ascii ? Spinner.ascii(spinner) : symbol
}

/** Semantic badge parts; extensions never need to choose glyphs or colors. */
export function statusBadge(
  state: AgentStatusState,
  spinner = new Spinner().glyph,
  options: { pad?: boolean } = {},
): ViewSegment[] {
  const badge = AGENT_STATUS_BADGES[state]
  const label = options.pad ? badge.label.padEnd(7) : badge.label
  return [{ kind: badge.role, text: `${badgeSymbol(state, spinner)} ${label}` }]
}

/** The same badge for transcript and picker rows. */
export function styledStatusBadge(
  state: AgentStatusState,
  theme: Theme,
  spinner?: string,
  options?: { pad?: boolean },
): string {
  return statusBadge(state, spinner, options)
    .map((part) => theme[AGENT_STATUS_BADGES[state].role](part.text))
    .join("")
}

/** The shared spinner frame for a moment, for surfaces that redraw on a clock rather than a tick. */
export function spinnerFrameAt(now: number): string {
  const frames = chromeGlyphs().spinnerFrames
  return frames[Math.floor(now / Spinner.INTERVAL_MS) % frames.length] ?? ""
}
