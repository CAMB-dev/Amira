import { setClockPreference } from "../src/clock.ts"

/** Capture synchronous frames with one clock style, independent of the host's locale preference. */
export function withSnapshotClock<Args extends unknown[], Result>(
  capture: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args) => {
    const restore = setClockPreference({ locale: "en-US", hourCycle: "h12" })
    try {
      return capture(...args)
    } finally {
      restore()
    }
  }
}
