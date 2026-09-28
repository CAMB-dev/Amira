import { afterEach, beforeEach, expect, test } from "bun:test"
import { bold, colorSupported, defaultTheme, red, setColorEnabled } from "../src/style.ts"

beforeEach(() => setColorEnabled(true))
afterEach(() => setColorEnabled(colorSupported(process.env)))

test("styles wrap text and survive nesting", () => {
  expect(red("x")).toBe("\x1b[31mx\x1b[39m")
  expect(red(`a${defaultTheme.success("b")}c`)).toBe("\x1b[31ma\x1b[32mb\x1b[39m\x1b[31mc\x1b[39m")
})

test("NO_COLOR disables colors but keeps text attributes", () => {
  expect(colorSupported({ NO_COLOR: "1" })).toBe(false)
  expect(colorSupported({ NO_COLOR: "" })).toBe(true)
  expect(colorSupported({})).toBe(true)
  setColorEnabled(false)
  expect(red("x")).toBe("x")
  expect(defaultTheme.accent("x")).toBe("x")
  expect(bold("x")).toBe("\x1b[1mx\x1b[22m")
})
