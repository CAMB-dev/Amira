import { expect, test } from "bun:test"
import { validateSettings } from "../src/config/index.ts"

for (const [key, max] of [
  ["margin", 12],
  ["marginRows", 2],
] as const) {
  test(`tui.${key} accepts every integer from 0 to ${max}`, () => {
    for (let value = 0; value <= max; value++) {
      const settings = { tui: { [key]: value } }
      expect(validateSettings(settings, "settings.json")).toEqual({ settings, warnings: [] })
    }
  })

  test(`tui.${key} rejects values outside its integer range`, () => {
    for (const value of [-1, max + 1, 0.5, "1", null, false]) {
      expect(() => validateSettings({ tui: { [key]: value } }, "settings.json")).toThrow(
        `"tui.${key}" must be a whole number between 0 and ${max}`,
      )
    }
  })
}

test("omitted TUI margins remain omitted for settings inheritance", () => {
  expect(validateSettings({ tui: {} }, "settings.json")).toEqual({ settings: { tui: {} }, warnings: [] })
})
