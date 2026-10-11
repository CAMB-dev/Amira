import { expect, spyOn, test } from "bun:test"
import type { ShimmerPreset } from "@amira/api"
import { resolveShimmer } from "@amira/core"
import { createTheme, Spinner, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { createTurnActivity } from "../src/app/activity.ts"
import { shimmerLabel } from "../src/app/activity-row.ts"
import { configureShimmer } from "../src/app/shimmer.ts"

// Prototype motion sampled at animationMs 0, 700, 1400, then rounded to the existing
// 16 gradient stops / 8 fade steps. Each entry asserts a cell's actual RGB ANSI.
const dark = ["0;0;0", "0;0;0", "0;0;0", "0;0;0", "0;0;0"]
const frames: Record<ShimmerPreset, string[][]> = {
  off: [dark, dark, dark],
  soft: [
    dark,
    ["150;0;0", "176;0;64", "98;0;112", "24;0;66", "0;0;0"],
    ["0;0;0", "0;0;0", "0;0;0", "0;0;0", "0;0;120"],
  ],
  sharp: [
    dark,
    ["0;0;0", "0;0;0", "0;0;0", "64;0;176", "0;0;240"],
    ["240;0;0", "176;0;64", "112;0;128", "0;0;0", "0;0;0"],
  ],
  wide: [
    dark,
    ["210;0;0", "110;0;40", "42;0;48", "8;0;22", "0;0;0"],
    ["120;0;0", "132;0;48", "98;0;112", "64;0;176", "0;0;240"],
  ],
  bounce: [
    dark,
    ["0;0;0", "66;0;24", "98;0;112", "64;0;176", "0;0;150"],
    ["0;0;0", "0;0;0", "0;0;0", "8;0;22", "0;0;150"],
  ],
  pulse: [
    dark,
    ["180;0;0", "132;0;48", "84;0;96", "48;0;132", "0;0;180"],
    ["150;0;0", "110;0;40", "70;0;80", "40;0;110", "0;0;150"],
  ],
  wave: [
    ["210;0;0", "196;0;14", "154;0;56", "112;0;98", "56;0;154"],
    ["56;0;154", "112;0;98", "168;0;42", "196;0;14", "210;0;0"],
    ["42;0;168", "0;0;210", "0;0;210", "28;0;182", "70;0;140"],
  ],
  reveal: [
    dark,
    ["240;0;0", "132;0;48", "42;0;48", "0;0;0", "0;0;0"],
    ["240;0;0", "176;0;64", "112;0;128", "64;0;176", "0;0;180"],
  ],
}

function context() {
  return {
    ...plain,
    color: true,
    theme: createTheme({
      theme: "dark",
      colorDepth: "truecolor",
      env: {},
      definition: { dark: { muted: "#000000" } },
      shimmerColors: ["#f00000", "#0000f0"],
    }),
  }
}

function cellColors(text: string): string[] {
  const cells: string[] = []
  let color = ""
  // biome-ignore lint/suspicious/noControlCharactersInRegex: inspect each cell's ANSI foreground
  for (const match of text.matchAll(/\x1b\[38;2;([\d;]+)m|\x1b\[39m|([^\x1b])/gu)) {
    if (match[1]) color = match[1]
    if (match[2]) cells.push(color)
  }
  return cells
}

for (const preset of Object.keys(frames) as ShimmerPreset[]) {
  test(`${preset} matches per-cell ANSI frames at fixed animationMs`, () => {
    const ctx = context()
    configureShimmer(ctx.theme, resolveShimmer(undefined, preset))
    for (const [index, time] of [0, 700, 1400].entries()) {
      const painted = shimmerLabel("ABCDE", ctx, time)
      expect(cellColors(painted)).toEqual(frames[preset][index]!)
      expect(stripAnsi(painted)).toBe("ABCDE")
    }
  })
}

test("unconfigured soft is byte-for-byte the previous sweep", () => {
  const ctx = context()
  for (const time of [0, 80, 400, 700, 1400, 1799, 1800, 2200]) {
    const label = "Responding…"
    const center = ((time % 1800) / 1800) * (label.length + 6) - 3
    const previous = [...label]
      .map((char, cell) => {
        const distance = Math.abs(cell - center)
        const fade = distance < 3 ? Math.round(Math.cos(((distance / 3) * Math.PI) / 2) ** 2 * 8) : 0
        const stop = Math.round((cell / (label.length - 1)) * 15)
        return (fade ? ctx.theme[`shimmer${stop}Fade${fade}`]! : ctx.theme.muted)(char)
      })
      .join("")
    expect(shimmerLabel(label, ctx, time)).toBe(previous)
  }
})

test("direction reverses every effect's per-cell motion and colour positions", () => {
  for (const preset of Object.keys(frames) as ShimmerPreset[]) {
    const ctx = context()
    configureShimmer(ctx.theme, resolveShimmer(undefined, { preset, direction: "rtl" }))
    expect(cellColors(shimmerLabel("ABCDE", ctx, 700))).toEqual([...frames[preset][1]!].reverse())
  }
})

test("bounce returns, reveal fades, pulse breathes and hard wave stays fully lit", () => {
  const ctx = context()
  configureShimmer(ctx.theme, resolveShimmer(undefined, "bounce"))
  expect(cellColors(shimmerLabel("ABCDE", ctx, 700))).toEqual(cellColors(shimmerLabel("ABCDE", ctx, 1700)))
  configureShimmer(ctx.theme, resolveShimmer(undefined, "reveal"))
  expect(cellColors(shimmerLabel("ABCDE", ctx, 1950))).toEqual([
    "30;0;0",
    "22;0;8",
    "14;0;16",
    "8;0;22",
    "0;0;30",
  ])
  configureShimmer(ctx.theme, resolveShimmer(undefined, "pulse"))
  expect(cellColors(shimmerLabel("ABCDE", ctx, 1000))).toEqual([
    "210;0;0",
    "154;0;56",
    "98;0;112",
    "56;0;154",
    "0;0;210",
  ])
  configureShimmer(ctx.theme, resolveShimmer(undefined, { preset: "wave", edge: "hard" }))
  expect(cellColors(shimmerLabel("ABCDE", ctx, 0))).toEqual([
    "240;0;0",
    "224;0;16",
    "176;0;64",
    "128;0;112",
    "64;0;176",
  ])
})

test("linear and hard edges respect overridden width and period", () => {
  const ctx = context()
  configureShimmer(ctx.theme, resolveShimmer(undefined, { width: 4, period: 900, edge: "linear" }))
  expect(cellColors(shimmerLabel("ABCDE", ctx, 400))).toEqual([
    "0;0;0",
    "88;0;32",
    "112;0;128",
    "32;0;88",
    "0;0;0",
  ])
  configureShimmer(ctx.theme, resolveShimmer(undefined, { width: 4, period: 900, edge: "hard" }))
  expect(cellColors(shimmerLabel("ABCDE", ctx, 400))).toEqual([
    "0;0;0",
    "176;0;64",
    "112;0;128",
    "64;0;176",
    "0;0;0",
  ])
})

test("wide glyphs use terminal-cell positions and combining glyphs stay intact", () => {
  const ctx = context()
  configureShimmer(ctx.theme, resolveShimmer(undefined, { width: 4, period: 900, edge: "linear" }))
  const label = "Ae\u0301界B"
  const painted = shimmerLabel(label, ctx, 400)
  expect(stripAnsi(painted)).toBe(label)
  expect(visibleWidth(painted)).toBe(5)
  expect(painted).toContain("\x1b[38;2;88;0;32me\u0301\x1b[39m")
  expect(painted).toContain("\x1b[38;2;112;0;128m界\x1b[39m")
  expect(painted).toContain("\x1b[38;2;0;0;0mB\x1b[39m")
})

test("every effect degrades to plain muted text without shimmer colour support", () => {
  for (const preset of Object.keys(frames) as ShimmerPreset[]) {
    for (const options of [
      { colorDepth: "16" },
      { theme: "terminal" },
      { env: { NO_COLOR: "1" } },
    ] as const) {
      const theme = createTheme({ theme: "dark", colorDepth: "truecolor", env: {}, ...options })
      configureShimmer(theme, resolveShimmer(undefined, preset))
      for (const time of [0, 700, 1400])
        expect(shimmerLabel("ABCDE", { ...plain, theme, color: true }, time)).toBe(theme.muted("ABCDE"))
    }
    const ctx = context()
    configureShimmer(ctx.theme, resolveShimmer(undefined, preset))
    expect(shimmerLabel("ABCDE", { ...ctx, color: false }, 700)).toBe(ctx.theme.muted("ABCDE"))
    expect(shimmerLabel("ABCDE", { ...plain, color: true }, 700)).toBe(plain.theme.muted("ABCDE"))
  }
})

test("idle picker preview uses the existing spinner ticks and animation clock", () => {
  let now = 1000
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  try {
    const ctx = context()
    const activity = createTurnActivity()
    const spinner = new Spinner()
    const options = { spinner, running: [], waiting: false, preview: true }
    expect(activity.render(100, ctx, { ...options, preview: false })).toEqual([])
    const first = activity.render(100, ctx, options)[0]!
    expect(stripAnsi(first)).toContain("Responding…")
    now += 700
    expect(activity.render(100, ctx, options)[0]).toBe(first)
    spinner.tick()
    expect(activity.render(100, ctx, options)[0]).not.toBe(first)
    expect(activity.working).toBe(false)
    expect(activity.render(100, ctx, { ...options, preview: false })).toEqual([])
  } finally {
    clock.mockRestore()
  }
})
