import { expect, test } from "bun:test"
import { stripAnsi } from "../src/ansi.ts"
import { truncateToWidth, visibleWidth, wrapText } from "../src/width.ts"

test("visibleWidth counts CJK and emoji as two cells and ignores escapes", () => {
  expect(visibleWidth("abc")).toBe(3)
  expect(visibleWidth("你好")).toBe(4)
  expect(visibleWidth("😀")).toBe(2)
  expect(visibleWidth("👨‍👩‍👧")).toBe(2)
  expect(visibleWidth("\x1b[31mab\x1b[0m")).toBe(2)
  expect(visibleWidth("a\x1b_tk:c\x07b")).toBe(2)
  expect(visibleWidth("\x1b]8;;http://x\x07link\x1b]8;;\x07")).toBe(4)
})

test("wraps at spaces and hard-breaks long words", () => {
  expect(wrapText("hello world foo", 11)).toEqual(["hello world", "foo"])
  expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"])
  expect(wrapText("a\nb\r\nc", 10)).toEqual(["a", "b", "c"])
  expect(wrapText("", 10)).toEqual([""])
})

test("wraps CJK by display width without splitting characters", () => {
  const lines = wrapText("你好世界你好", 5)
  expect(lines).toEqual(["你好", "世界", "你好"])
  for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(5)
  expect(wrapText("ab你好", 3)).toEqual(["ab", "你", "好"])
})

test("wraps emoji and ZWJ sequences as whole graphemes", () => {
  expect(wrapText("😀😀😀", 4)).toEqual(["😀😀", "😀"])
  expect(wrapText("a👨‍👩‍👧b", 2)).toEqual(["a", "👨‍👩‍👧", "b"])
})

test("never splits escape sequences and carries styles across lines", () => {
  const red = "\x1b[31m"
  const lines = wrapText(`${red}aaaa bbbb\x1b[0m cc`, 4)
  expect(lines.map(stripAnsi)).toEqual(["aaaa", "bbbb", "cc"])
  expect(lines[0]).toBe(`${red}aaaa\x1b[0m`)
  expect(lines[1]!.startsWith(red)).toBe(true)
  expect(lines[2]).toBe("cc")
  for (const l of lines) expect(l.replaceAll(/.\[[0-9;]*m/g, "")).not.toContain("\x1b")
})

test("truncateToWidth respects wide characters and styles", () => {
  expect(truncateToWidth("你好世界", 5)).toBe("你好")
  expect(truncateToWidth("hello world", 8, "…")).toBe("hello w…")
  expect(truncateToWidth("short", 10)).toBe("short")
  const t = truncateToWidth("\x1b[31mabcdef\x1b[0m", 3)
  expect(stripAnsi(t)).toBe("abc")
  expect(t.endsWith("\x1b[0m")).toBe(true)
})
