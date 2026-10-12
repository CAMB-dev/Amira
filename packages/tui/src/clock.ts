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

/** Display times use the local timezone and the selected locale's hour cycle. */
export function localClock(at: number): string {
  return clock(at)
}
