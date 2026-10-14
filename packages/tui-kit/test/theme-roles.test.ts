import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { stripAnsi } from "../src/ansi.ts"
import { channels } from "../src/colors.ts"
import { palettes } from "../src/palette.ts"
import { createTheme, monoTheme, type StyleFn, stripColors, type ThemeDefinition } from "../src/style.ts"

const names = ["amira", "amber", "burnt", "lavender", "mono", "ascii"]
const references = ["path", "command", "code", "heading1", "heading", "subheading", "link", "linkUrl"]
const options = { env: {}, platform: "other" } as const

function definition(name: string): ThemeDefinition {
  return JSON.parse(readFileSync(new URL(`../../cli/themes/${name}.json`, import.meta.url), "utf8"))
}

function foreground(style: StyleFn): number[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: inspect rendered foreground SGR
  const sgr = style("reference").match(/\x1b\[38;(2;\d+;\d+;\d+|5;\d+)m/)![1]!
  if (sgr.startsWith("2;")) return sgr.split(";").slice(1).map(Number)
  const index = Number(sgr.slice(2))
  if (index >= 232) return Array(3).fill(8 + (index - 232) * 10)
  const cube = index - 16
  const steps = [0, 95, 135, 175, 215, 255]
  return [steps[Math.floor(cube / 36)]!, steps[Math.floor(cube / 6) % 6]!, steps[cube % 6]!]
}

function luminance(rgb: number[]): number {
  const linear = rgb.map((value) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

function contrast(a: number[], b: number[]): number {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a)
  return (values[0]! + 0.05) / (values[1]! + 0.05)
}

for (const name of names) {
  for (const appearance of ["dark", "light"] as const) {
    test(`${name} ${appearance} distinguishes heading levels without changing reference color`, () => {
      const data = definition(name)
      for (const colorDepth of ["truecolor", "256", "16"] as const) {
        const theme = createTheme({ ...options, definition: data, themeVariant: appearance, colorDepth })
        const headings = [theme.heading1!("Heading"), theme.heading!("Heading"), theme.subheading!("Heading")]
        expect(new Set(headings).size).toBe(3)
        expect(headings.map(stripColors)).toEqual([
          "\x1b[1m\x1b[4mHeading\x1b[24m\x1b[22m",
          "\x1b[1mHeading\x1b[22m",
          "\x1b[1m\x1b[3mHeading\x1b[23m\x1b[22m",
        ])
        if (colorDepth !== "16") {
          for (const token of ["heading1", "heading", "subheading"]) {
            expect(foreground(theme[token]!)).toEqual(foreground(theme.path))
          }
        } else {
          for (const heading of headings) expect(heading).toContain("\x1b[34m")
        }
      }
    })

    test(`${name} ${appearance} separates reference sky from interactive accent and preserves status`, () => {
      const data = definition(name)
      const palette = { ...palettes[appearance], ...data[appearance] }
      for (const colorDepth of ["truecolor", "256"] as const) {
        const theme = createTheme({ ...options, definition: data, themeVariant: appearance, colorDepth })
        const sky = foreground(theme.path)
        expect(sky[2]).toBeGreaterThan(sky[0]!)
        expect(sky[2]).toBeGreaterThan(sky[1]!)
        expect(sky).not.toEqual(foreground(theme.accent))
        for (const token of references) {
          expect(foreground(theme[token]!)).toEqual(sky)
          for (const background of [palette.bg, palette.userBg, palette.codeBg]) {
            expect(contrast(foreground(theme[token]!), channels(background))).toBeGreaterThanOrEqual(4.5)
          }
        }
        expect(theme.thinking("Thought")).toBe(theme.muted("Thought"))
        const base = createTheme({ ...options, theme: appearance, colorDepth })
        for (const token of ["success", "warning", "error"])
          expect(theme[token]!("status")).toBe(base[token]!("status"))
      }
    })
  }
}

test("structural code frames retain their unpainted fallback styling", () => {
  for (const appearance of ["dark", "light"] as const) {
    for (const colorDepth of ["truecolor", "256", "16"] as const) {
      const theme = createTheme({ ...options, theme: appearance, colorDepth })
      expect(theme.codeFrame!("ts")).toBe(theme.muted("ts"))
    }
  }
  expect(monoTheme.codeFrame!("ts")).toBe(monoTheme.muted("ts"))
})

test("reference roles remain distinct from accent at ANSI depth and readable without color", () => {
  const ansi = createTheme({ ...options, colorDepth: "16" })
  for (const token of references) {
    expect(ansi[token]!("reference")).not.toContain("\x1b[36m")
    expect(stripAnsi(ansi[token]!("reference"))).toBe("reference")
    expect(stripAnsi(monoTheme[token]!("reference"))).toBe("reference")
  }
  expect(ansi.thinking("Thought")).toBe(ansi.muted("Thought"))
  expect(monoTheme.path("reference")).toContain("\x1b[4m")
  expect(monoTheme.link!("reference")).toContain("\x1b[4m")
  expect(monoTheme.heading!("reference")).toContain("\x1b[1m")
  expect(monoTheme.codeTicks!("`")).toContain("`")
})
