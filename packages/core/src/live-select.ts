import type { UiApi } from "@amira/api"
import type { EventBus } from "./event-bus.ts"

export type SelectLive = NonNullable<Parameters<UiApi["choose"]>[2]["live"]>
export type SelectPresentation = ReturnType<typeof selectPresentation>

/** How often an open live select is read again, so elapsed times tick without events. */
const LIVE_REFRESH_MS = 1000

/** Only display data leaves the host; option strings remain the answer identities. */
export function selectPresentation(live: SelectLive) {
  const { optionLabels, optionStatuses, descriptions } = live()
  return {
    ...(optionLabels ? { optionLabels: [...optionLabels] } : {}),
    ...(optionStatuses ? { optionStatuses: [...optionStatuses] } : {}),
    ...(descriptions ? { descriptions: [...descriptions] } : {}),
  }
}

/**
 * Reads a live select's presentation again on host events and, while an option shows a working
 * badge, on a clock for work that emits none (a job's output), so its elapsed time ticks;
 * calls `changed` when it differs. Static choices keep no timer. Returns the unsubscribe.
 */
export function watchLiveSelect(
  bus: EventBus,
  live: SelectLive,
  initial: SelectPresentation,
  changed: (next: SelectPresentation) => void,
): () => void {
  let previous = JSON.stringify(initial)
  let clock: ReturnType<typeof setInterval> | undefined
  const tick = (shown: SelectPresentation) => {
    const working = !!shown.optionStatuses?.includes("working")
    if (working && clock === undefined) clock = setInterval(refresh, LIVE_REFRESH_MS)
    else if (!working && clock !== undefined) {
      clearInterval(clock)
      clock = undefined
    }
  }
  function refresh() {
    const next = selectPresentation(live)
    tick(next)
    const serialized = JSON.stringify(next)
    if (serialized === previous) return
    previous = serialized
    changed(next)
  }
  const off = bus.subscribe((e) => {
    // Presentation updates must not feed back into themselves or reopen closed choices.
    if (!e.type.startsWith("ui.")) refresh()
  })
  tick(initial)
  return () => {
    off()
    clearInterval(clock)
  }
}
