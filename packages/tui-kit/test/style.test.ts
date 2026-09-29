import { expect, test } from "bun:test"
import { stripAnsi } from "../src/ansi.ts"
import { renderMarkdown } from "../src/components/markdown-stream.ts"
import {
  blue,
  bold,
  colorSupported,
  defaultTheme,
  monoTheme,
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

test("a dumb terminal gets no colors either", () => {
  expect(colorSupported({ TERM: "dumb" })).toBe(false)
  expect(colorSupported({ TERM: "xterm-256color" })).toBe(true)
})

test("without colors the mono theme tells things apart by attributes, which survive stripColors", () => {
  const md = "# One\n\n## Two\n\n### Three\n\nuse `npm test` now"
  const rows = renderMarkdown(md, 40, monoTheme, { hyperlinks: false }).map(stripColors)
  const h1 = rows.find((r) => r.includes("One"))!
  const h2 = rows.find((r) => r.includes("Two"))!
  const h3 = rows.find((r) => r.includes("Three"))!
  // Three different looks: bold and underlined, bold, bold and italic.
  expect(new Set([h1, h2, h3].map((r) => r.replace(/One|Two|Three/, ""))).size).toBe(3)
  expect(h1).toContain("\x1b[4m")
  // Inline code keeps its backticks, and they count in the width.
  const code = rows.find((r) => r.includes("npm test"))!
  expect(stripAnsi(code)).toBe("use `npm test` now")
  expect(stripColors(monoTheme.muted("x"))).toBe("\x1b[2mx\x1b[22m")
  expect(stripColors(monoTheme.accent("x"))).toBe("\x1b[1mx\x1b[22m")
})

test("with colors inline code shows without its backticks", () => {
  const rows = renderMarkdown("use `npm test` now", 40, defaultTheme, { hyperlinks: false })
  expect(stripAnsi(rows[0]!)).toBe("use npm test now")
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
