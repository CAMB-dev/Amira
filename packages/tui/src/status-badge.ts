import { AGENT_STATUS_BADGES, type AgentStatusState, type ViewSegment } from "@amira/api"
import { Spinner, type Theme } from "@amira/tui-kit"
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

/** Semantic badge parts; extensions never need to choose glyphs or colors. */
export function statusBadge(
  state: AgentStatusState,
  spinner = new Spinner().glyph,
  options: { pad?: boolean } = {},
): ViewSegment[] {
  const badge = AGENT_STATUS_BADGES[state]
  const ascii = /^[\x20-\x7e]+$/.test(glyphs.pointer)
  const configured = glyphs[keys[state]]
  let symbol = ascii && configured === badge.symbol ? badge.ascii : configured
  if (state === "working") {
    if (symbol === badge.symbol) symbol = spinner
    else if (symbol === badge.ascii) symbol = Spinner.ascii(spinner)
  }
  const label = options.pad ? badge.label.padEnd(7) : badge.label
  return [{ kind: badge.role, text: `${symbol} ${label}` }]
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
