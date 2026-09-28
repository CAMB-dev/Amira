import { expect, test } from "bun:test"
import { blue, bold, colorSupported, defaultTheme, red, stripColors, type Theme } from "../src/style.ts"

test("styles wrap text and survive nesting", () => {
  expect(red("x")).toBe("\x1b[31mx\x1b[39m")
  expect(red(`a${defaultTheme.success("b")}c`)).toBe("\x1b[31ma\x1b[32mb\x1b[39m\x1b[31mc\x1b[39m")
})

test("NO_COLOR turns colors off by default", () => {
  expect(colorSupported({ NO_COLOR: "1" })).toBe(false)
  expect(colorSupported({ NO_COLOR: "" })).toBe(true)
  expect(colorSupported({})).toBe(true)
})

test("stripColors keeps text attributes", () => {
  expect(stripColors(red("x"))).toBe("x")
  expect(stripColors(bold("x"))).toBe("\x1b[1mx\x1b[22m")
  expect(stripColors("\x1b[1;38;5;196;48:2::1:2:3mx\x1b[0m")).toBe("\x1b[1mx\x1b[0m")
  expect(stripColors("\x1b[mx")).toBe("\x1b[0mx")
})

test("a theme can carry tokens of its own", () => {
  const theme: Theme = { ...defaultTheme, link: blue }
  expect(theme.link?.("x")).toBe(blue("x"))
  expect(theme.accent("x")).toBe(defaultTheme.accent("x"))
})
