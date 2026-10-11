import { expect, test } from "bun:test"
import { blend, nearest256 } from "../src/colors.ts"
import { createTheme, monoTheme, themeToken } from "../src/style.ts"

const colors = ["#aabbcc", "#112233"] as const

test("custom shimmer stops and all fade steps are precomputed without changing other palette tokens", () => {
  for (const depth of ["truecolor", "256"] as const) {
    const theme = createTheme({ env: {}, colorDepth: depth, shimmerColors: colors })
    const normal = createTheme({ env: {}, colorDepth: depth })
    expect(theme.accent("x")).toBe(normal.accent("x"))
    expect(theme.muted("x")).toBe(normal.muted("x"))
    const foreground = (hex: `#${string}`) =>
      depth === "256"
        ? `\x1b[38;5;${nearest256(hex)}mx\x1b[39m`
        : `\x1b[38;2;${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";")}mx\x1b[39m`
    expect(theme.shimmer("x")).toBe(foreground(colors[0]))
    expect(theme.shimmerEnd!("x")).toBe(foreground(colors[1]))
    for (let stop = 0; stop < 16; stop++) {
      const highlight = blend(colors[0], colors[1], stop / 15)
      for (let fade = 1; fade <= 8; fade++) {
        expect(themeToken(theme, `shimmer${stop}Fade${fade}`)?.("x")).toBe(
          foreground(blend("#727272", highlight, fade / 8)),
        )
      }
    }
  }
})

test("custom stops do not create animation tokens without colour support", () => {
  for (const options of [{ colorDepth: "16" }, { theme: "terminal" }, { env: { NO_COLOR: "1" } }] as const) {
    const theme = createTheme({ colorDepth: "truecolor", env: {}, shimmerColors: colors, ...options })
    expect(themeToken(theme, "shimmer0Fade8")).toBeUndefined()
  }
  expect(createTheme({ env: {}, color: false, shimmerColors: colors })).toBe(monoTheme)
})
