// A/B/D deliberate UI oracles: shared two-cell grid, fill-only code, rounded dialogs, › and ·.
import { expect, test } from "bun:test"
import { defaultTheme, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { createLocalClock, setClockPreference } from "../src/clock.ts"
import { localClock, timestampRoom, userLines } from "../src/format.ts"

const at = new Date(2026, 9, 10, 20, 9).getTime()

for (const cycle of ["h11", "h12", "h23", "h24"] as const) {
  test(`clock respects the selected ${cycle} hour-cycle preference`, () => {
    const restore = setClockPreference({ locale: "en-US", hourCycle: cycle })
    try {
      const twelve = cycle === "h11" || cycle === "h12"
      expect(localClock(at)).toBe(twelve ? "8:09 PM" : "20:09")
      expect(timestampRoom(30, at)).toBe(twelve ? 21 : 23)
      const midnight = new Date(2026, 9, 10, 0, 4).getTime()
      expect(localClock(midnight)).toBe(twelve ? "12:04 AM" : "00:04")
    } finally {
      restore()
    }
  })
}

for (const [locale, expected] of [
  ["en-US", "8:09 PM"],
  ["en-GB", "20:09"],
] as const) {
  test(`clock detects ${locale}'s default hour cycle without a global Intl override`, () => {
    expect(createLocalClock({ locale })(at)).toBe(expected)
  })
}

test("clock defaults to 12-hour time when the hour cycle or locale data is unavailable", () => {
  expect(createLocalClock({ locale: "en-US", hourCycle: null })(at)).toBe("8:09 PM")
  expect(createLocalClock({ locale: "invalid_locale" })(at)).toBe("8:09 PM")
})

test("the default clock uses the system locale and local timezone", () => {
  const cycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle
  const hour12 = cycle ? cycle === "h11" || cycle === "h12" : true
  const expected = new Intl.DateTimeFormat(undefined, {
    hour: hour12 ? "numeric" : "2-digit",
    minute: "2-digit",
    hour12,
  })
  expect(createLocalClock()(at)).toBe(expected.format(at).replace(/[\u00a0\u202f]/g, " "))
})

test("24-hour clocks reserve five cells and preserve the full wrapped content", () => {
  const restore = setClockPreference({ locale: "en-GB", hourCycle: "h23" })
  try {
    const rows = userLines(
      defaultTheme,
      { role: "user", content: [{ type: "text", text: "x".repeat(40) }] },
      30,
      at,
    ).map(stripAnsi)
    expect(timestampRoom(30, at)).toBe(23)
    expect(rows).toEqual([`› ${"x".repeat(21)}  20:09`, `  ${"x".repeat(19)}`])
    expect(rows.map(visibleWidth)).toEqual([30, 21])
  } finally {
    restore()
  }
})

test("12:45 PM reserves its actual cells plus the two-cell clock gap", () => {
  const restore = setClockPreference({ locale: "en-US", hourCycle: "h12" })
  try {
    const noon = new Date(2026, 9, 10, 12, 45).getTime()
    const rows = userLines(
      defaultTheme,
      { role: "user", content: [{ type: "text", text: "x".repeat(40) }] },
      30,
      noon,
    ).map(stripAnsi)
    expect(localClock(noon)).toBe("12:45 PM")
    expect(timestampRoom(30, noon)).toBe(20)
    expect(rows).toEqual([`› ${"x".repeat(18)}  12:45 PM`, `  ${"x".repeat(22)}`])
    expect(rows.map(visibleWidth)).toEqual([30, 24])
    expect(timestampRoom(15, noon)).toBe(15)
    expect(timestampRoom(30, undefined)).toBe(30)
    expect(timestampRoom(Infinity, noon)).toBe(Infinity)
  } finally {
    restore()
  }
})
