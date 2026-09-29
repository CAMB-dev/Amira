import { expect, test } from "bun:test"
import {
  blue,
  bold,
  colorSupported,
  defaultTheme,
  red,
  stripColors,
  surfaceTheme,
  type Theme,
  themeToken,
} from "../src/style.ts"

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

test("surface colors suit the background, and are not in the default theme", () => {
  expect(surfaceTheme("dark").userBg("x")).toBe("\x1b[48;5;236mx\x1b[49m")
  expect(surfaceTheme("light").userBg("x")).toBe("\x1b[48;5;254mx\x1b[49m")
  expect(surfaceTheme(undefined).diffRemovedBg("x")).toBe("\x1b[48;5;131mx\x1b[49m")
  // A word's background inside a line's: the line's comes back after it.
  const s = surfaceTheme("dark")
  expect(s.diffAddedBg(`a${s.diffAddedWordBg("b")}c`)).toBe(
    "\x1b[48;5;22ma\x1b[48;5;28mb\x1b[49m\x1b[48;5;22mc\x1b[49m",
  )
  expect(stripColors(s.userBg("hi"))).toBe("hi")
  expect(themeToken(defaultTheme, "userBg")).toBeUndefined()
  expect(themeToken({ ...defaultTheme, ...s }, "userBg")).toBe(s.userBg)
})
