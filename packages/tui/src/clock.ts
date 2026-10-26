interface ClockPreference {
  locale?: string
  /** null represents unavailable locale data, which defaults to a 12-hour clock. */
  hourCycle?: Intl.DateTimeFormatOptions["hourCycle"] | null
}

/** Detect once per formatter; explicit preferences make captures independent of the host. */
export function createLocalClock(preference: ClockPreference = {}): (at: number) => string {
  let formatter: Intl.DateTimeFormat
  try {
    const cycle =
      preference.hourCycle === undefined
        ? new Intl.DateTimeFormat(preference.locale, { hour: "numeric" }).resolvedOptions().hourCycle
        : preference.hourCycle
    const hour12 = cycle ? cycle === "h11" || cycle === "h12" : true
    formatter = new Intl.DateTimeFormat(preference.locale, {
      hour: hour12 ? "numeric" : "2-digit",
      minute: "2-digit",
      hour12,
    })
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
  }
  return (at) => formatter.format(at).replace(/[\u00a0\u202f]/g, " ")
}

let clock = createLocalClock()

/** Internal capture seam. Production keeps the system locale and local timezone. */
export function setClockPreference(preference: ClockPreference): () => void {
  const previous = clock
  clock = createLocalClock(preference)
  return () => {
    clock = previous
  }
}

type ClockSetting = "auto" | "12h" | "24h" | undefined

/** The clock before the running interactive session applied tui.clock; "auto" goes back to it. */
let runBase: typeof clock | undefined

function useClockSetting(setting: ClockSetting): void {
  // A forced 12-hour clock reads as the English interface does ("8:19 PM"), whatever the locale.
  if (setting === "12h") clock = createLocalClock({ locale: "en-US", hourCycle: "h12" })
  else if (setting === "24h") clock = createLocalClock({ hourCycle: "h23" })
  else clock = runBase ?? clock
}

/**
 * Applies the tui.clock setting for one interactive run: "12h" ("8:19 PM") and "24h" ("20:19")
 * force the hour cycle; "auto" (the default) leaves the system locale's clock alone.
 */
export function applyClockSetting(setting: ClockSetting): () => void {
  const previous = clock
  runBase = previous
  useClockSetting(setting)
  return () => {
    clock = previous
    runBase = undefined
  }
}

/** Reloaded settings (/reload) change the running session's clock; outside a run it is ignored. */
export function reloadClockSetting(setting: ClockSetting): void {
  if (runBase) useClockSetting(setting)
}

/** Display times use the local timezone and the selected locale's hour cycle. */
export function localClock(at: number): string {
  return clock(at)
}
