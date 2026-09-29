import { expect, test } from "bun:test"
import { clip, formatDuration, formatElapsed, formatTokens, padCells, plural } from "../src/format.ts"

test("plural counts with the right noun", () => {
  expect(plural(1, "line")).toBe("1 line")
  expect(plural(0, "line")).toBe("0 lines")
  expect(plural(2, "match", "matches")).toBe("2 matches")
})

test("tokens are compact and round before picking the unit", () => {
  expect(formatTokens(999)).toBe("999")
  expect(formatTokens(1234)).toBe("1.2k")
  expect(formatTokens(9_960)).toBe("10k")
  expect(formatTokens(46_200)).toBe("46k")
  expect(formatTokens(2_500_000)).toBe("2.5M")
})

test("durations: tenths under a minute, then minutes and hours", () => {
  expect(formatDuration(400)).toBe("0.4s")
  expect(formatDuration(12_340)).toBe("12.3s")
  expect(formatDuration(59_970)).toBe("1m 00s")
  expect(formatDuration(125_000)).toBe("2m 05s")
  expect(formatDuration(3_720_000)).toBe("1h 02m")
})

test("elapsed time ticks in whole seconds", () => {
  expect(formatElapsed(4_900)).toBe("4s")
  expect(formatElapsed(65_000)).toBe("1m 05s")
  expect(formatElapsed(-5)).toBe("0s")
})

test("clip cuts by terminal cells and never splits a wide character", () => {
  expect(clip("hello", 10)).toBe("hello")
  expect(clip("hello world", 6)).toBe("hello…")
  // Each CJK character takes two cells.
  expect(clip("你好世界", 5)).toBe("你好…")
  expect(clip("a😀b", 2)).toBe("a…")
  expect(clip("abc", 0)).toBe("")
})

test("padCells pads to a width in cells", () => {
  expect(padCells("你", 4)).toBe("你  ")
  expect(padCells("abcdef", 3)).toBe("abcdef")
})
