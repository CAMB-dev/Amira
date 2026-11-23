import { expect, test } from "bun:test"
import type { ShimmerEffect, ShimmerPreset } from "@amira/api"
import { normalizeShimmer, resolveShimmer, SHIMMER_PRESETS } from "../src/shimmer.ts"

function normalized(value: unknown) {
  const notices: string[] = []
  const result = normalizeShimmer(value, (text) => void notices.push(text))
  return { result, notices }
}

test("all shimmer presets expand to required knobs without overriding colors", () => {
  const names: ShimmerPreset[] = ["off", "soft", "sharp", "wide", "bounce", "pulse", "wave", "reveal"]
  expect(Object.keys(SHIMMER_PRESETS)).toEqual(names)
  for (const preset of names) {
    expect(normalized(preset)).toEqual({ result: { preset }, notices: [] })
    expect(resolveShimmer(preset)).toEqual(SHIMMER_PRESETS[preset])
    expect(Object.keys(SHIMMER_PRESETS[preset]).sort()).toEqual([
      "direction",
      "edge",
      "period",
      "style",
      "width",
    ])
  }
  expect(resolveShimmer()).toEqual({ style: "sweep", width: 6, period: 1800, edge: "soft", direction: "ltr" })
  expect(names.map((name) => [name, SHIMMER_PRESETS[name].width, SHIMMER_PRESETS[name].period])).toEqual([
    ["off", 6, 1800],
    ["soft", 6, 1800],
    ["sharp", 3, 1100],
    ["wide", 12, 2600],
    ["bounce", 6, 2400],
    ["pulse", 6, 2000],
    ["wave", 6, 2200],
    ["reveal", 6, 2000],
  ])
  expect(normalized({ edge: "linear" })).toEqual({ result: { edge: "linear" }, notices: [] })
})

test("explicit knobs override each layer's preset and user knobs keep unrelated theme values", () => {
  const theme: ShimmerEffect = {
    preset: "bounce",
    width: 10,
    period: 3100,
    direction: "rtl",
    colors: ["#123456", "#abcdef"],
  }
  expect(resolveShimmer(theme, { width: 4 })).toEqual({
    ...SHIMMER_PRESETS.bounce,
    width: 4,
    period: 3100,
    direction: "rtl",
    colors: ["#123456", "#abcdef"],
  })
  expect(resolveShimmer(theme, { preset: "sharp", width: 8, period: 1700 })).toEqual({
    ...SHIMMER_PRESETS.sharp,
    width: 8,
    period: 1700,
    colors: ["#123456", "#abcdef"],
  })
  expect(resolveShimmer({ preset: "wide", style: "reveal", width: 9 })).toEqual({
    ...SHIMMER_PRESETS.wide,
    style: "reveal",
    width: 9,
  })
})

test("off disables a theme animation and an explicit user style can re-enable it", () => {
  expect(resolveShimmer("bounce", "off").style).toBe("off")
  expect(resolveShimmer("off", { width: 8 }).style).toBe("off")
  expect(resolveShimmer("off", { style: "wave" }).style).toBe("wave")
})

test("wave inherits theme colors instead of introducing a rainbow", () => {
  expect(resolveShimmer("wave").colors).toBeUndefined()
  expect(resolveShimmer({ colors: ["#123456", "#abcdef"] }, "wave").colors).toEqual(["#123456", "#abcdef"])
})

test("sweep is accepted only as an object preset alias for soft", () => {
  expect(normalized({ preset: "sweep", width: 5 })).toEqual({
    result: { preset: "soft", width: 5 },
    notices: [],
  })
  expect(normalized("sweep").result).toBeUndefined()
  expect(normalized({ style: "sweep" }).notices).toEqual([])
})

test("missing and empty shimmer options are harmless and preserve inheritance", () => {
  expect(normalized(undefined)).toEqual({ result: undefined, notices: [] })
  expect(normalized({})).toEqual({ result: {}, notices: [] })
  expect(resolveShimmer("bounce", {})).toEqual(SHIMMER_PRESETS.bounce)
})

test("invalid blocks produce one notice and no usable override", () => {
  for (const value of [null, false, 1, [], ["soft"], "unknown", "toString", { preset: "unknown" }]) {
    const { result, notices } = normalized(value)
    expect(result).toBeUndefined()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("Invalid shimmer configuration")
  }
})

test("invalid fields and unknown keys are stripped while valid knobs survive with one notice", () => {
  const { result, notices } = normalized({
    preset: "unknown",
    style: "spin",
    edge: "sharp",
    direction: "up",
    colors: ["red", "#ffffff"],
    width: 7,
    period: 2400,
    extra: true,
  })
  expect(result).toEqual({ width: 7, period: 2400 })
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain('unknown field "extra"')
  expect(resolveShimmer("bounce", { width: "bad", period: 2100 } as unknown as ShimmerEffect)).toEqual({
    ...SHIMMER_PRESETS.bounce,
    period: 2100,
  })
})

test("finite numbers clamp to safe ranges and width rounds to whole cells with one notice", () => {
  expect(normalized({ width: -20, period: 1 })).toEqual({
    result: { width: 1, period: 400 },
    notices: [expect.stringContaining("width clamped")],
  })
  const upper = normalized({ width: 1000, period: 100000 })
  expect(upper.result).toEqual({ width: 20, period: 5000 })
  expect(upper.notices).toHaveLength(1)
  expect(normalized({ width: 5.6 }).result).toEqual({ width: 6 })
  expect(normalized({ width: 5.6 }).notices).toHaveLength(1)
  expect(normalized({ width: 1, period: 400 }).notices).toEqual([])
  expect(normalized({ width: 20, period: 5000 }).notices).toEqual([])
  expect(normalized({ width: NaN, period: Infinity, style: "pulse" }).result).toEqual({ style: "pulse" })
  expect(normalized({ width: "6", period: -Infinity }).notices).toHaveLength(1)
})

test("shared and appearance-specific color pairs normalize opaque RGB hex", () => {
  expect(normalized({ colors: ["#AbC", "#FEDCBA"] })).toEqual({
    result: { colors: ["#aabbcc", "#fedcba"] },
    notices: [],
  })
  const colors = { dark: ["#123", "#ABC"], light: ["#DEF", "#456789"] }
  expect(normalized({ colors }).result).toEqual({
    colors: { dark: ["#112233", "#aabbcc"], light: ["#ddeeff", "#456789"] },
  })
  expect(
    resolveShimmer({ colors: ["#111111", "#222222"] }, { colors: ["#333333", "#444444"] }).colors,
  ).toEqual(["#333333", "#444444"])
})

test("invalid color shapes and alpha, CSS, or ANSI colors are ignored as one field", () => {
  for (const colors of [
    ["#123"],
    ["#123", "#456", "#789"],
    ["#1234", "#456"],
    ["#12345678", "#456"],
    ["cyan", "#456"],
    ["rgb(1,2,3)", "#456"],
    ["\x1b[31m", "#456"],
    { dark: ["#123", "#456"] },
    { dark: ["#123", "#456"], light: ["invalid", "#456"] },
  ]) {
    const { result, notices } = normalized({ style: "wave", colors })
    expect(result).toEqual({ style: "wave" })
    expect(notices).toHaveLength(1)
  }
  const unknown = normalized({ colors: { dark: ["#123", "#456"], light: ["#123", "#456"], extra: true } })
  expect(unknown.result?.colors).toEqual({ dark: ["#112233", "#445566"], light: ["#112233", "#445566"] })
  expect(unknown.notices).toHaveLength(1)
})

test("normalization does not mutate input or allow unreadable fields and notice sinks to break startup", () => {
  const colors = ["#ABC", "#DEF"]
  const value = { width: 500, colors }
  const result = normalizeShimmer(value)
  expect(value).toEqual({ width: 500, colors: ["#ABC", "#DEF"] })
  colors[0] = "#000"
  expect(result?.colors).toEqual(["#aabbcc", "#ddeeff"])
  const unreadable = normalized({
    width: 4,
    get period() {
      throw new Error("getter failed")
    },
  })
  expect(unreadable.result).toEqual({ width: 4 })
  expect(unreadable.notices).toHaveLength(1)
  expect(() =>
    normalizeShimmer(false, () => {
      throw new Error("notice failed")
    }),
  ).not.toThrow()
})
