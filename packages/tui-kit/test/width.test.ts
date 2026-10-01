import { expect, test } from "bun:test"
import { stripAnsi } from "../src/ansi.ts"
import {
  closeStyles,
  graphemes,
  sanitize,
  tokenize,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "../src/width.ts"

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

test("wraps a paragraph into hundreds of thousands of rows without overflowing the stack", () => {
  expect(wrapText("a".repeat(700_000), 1).length).toBe(700_000)
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

test("only SGR and OSC 8 escapes survive; other escapes and control characters are dropped", () => {
  const link = "\x1b]8;;http://x\x07link\x1b]8;;\x07"
  expect(sanitize(`\x1b[31ma\x1b[0m${link}`)).toBe(`\x1b[31ma\x1b[0m${link}`)
  expect(sanitize("a\x1b[3A\x1b[2Kb\x1b[J\x1b7\x1bc\x1b]0;title\x07c")).toBe("abc")
  expect(sanitize("a\rb\x08c\x07d\x00e\x9bf\x7f")).toBe("abcdef")
  expect(sanitize("x\x1b")).toBe("x")
  expect(tokenize("\x1b[2Jab").map((t) => t.text)).toEqual(["a", "b"])
  expect(visibleWidth("a\x1b[5Cb")).toBe(2)
})

test("tabs expand to the next tab stop", () => {
  expect(sanitize("a\tb")).toBe("a   b")
  expect(sanitize("abcd\tb")).toBe("abcd    b")
  expect(sanitize("a\nb\tc")).toBe("a\nb   c")
  expect(visibleWidth("\t你")).toBe(6)
  expect(wrapText("a\tb", 10)).toEqual(["a   b"])
  expect(truncateToWidth("\t\tx", 6)).toBe("      ")
})

test("styled text starting with a space never wraps into a style-only blank line", () => {
  const lines = wrapText("\x1b[31m abcdefgh\x1b[0m", 4)
  expect(lines.map(stripAnsi)).toEqual([" abc", "defg", "h"])
})

test("truncating inside a hyperlink still closes it", () => {
  const link = "\x1b]8;;http://x\x07linktext\x1b]8;;\x07 more"
  expect(truncateToWidth(link, 4)).toBe("\x1b]8;;http://x\x07link\x1b]8;;\x07")
  expect(truncateToWidth(`\x1b[1m${link}`, 4)).toBe("\x1b[1m\x1b]8;;http://x\x07link\x1b]8;;\x07\x1b[0m")
  expect(closeStyles("\x1b]8;;http://x\x07link")).toBe("\x1b]8;;http://x\x07link\x1b]8;;\x07\x1b[0m")
  expect(closeStyles("plain")).toBe("plain")
})

test("wrapping closes and re-opens a hyperlink on each line", () => {
  const lines = wrapText("\x1b]8;;http://x\x07aaaa bbbb\x1b]8;;\x07 cc", 4)
  expect(lines).toEqual([
    "\x1b]8;;http://x\x07aaaa\x1b]8;;\x07",
    "\x1b]8;;http://x\x07bbbb\x1b]8;;\x07",
    "cc",
  ])
})

test("combined and colon SGR parameters are closed by their own close codes", () => {
  expect(wrapText("\x1b[1;31mab\x1b[22mcd efgh", 4)).toEqual([
    "\x1b[1;31mab\x1b[22mcd\x1b[0m",
    "\x1b[31mefgh\x1b[0m",
  ])
  expect(wrapText("\x1b[38:5:196mab\x1b[39mcd efgh", 4)).toEqual(["\x1b[38:5:196mab\x1b[39mcd", "efgh"])
  expect(wrapText("\x1b[1;38;5;196mab\x1b[39mcd ef", 4)).toEqual([
    "\x1b[1;38;5;196mab\x1b[39mcd\x1b[0m",
    "\x1b[1mef\x1b[0m",
  ])
  expect(wrapText("\x1b[31m\x1b[32mab cd", 2)).toEqual(["\x1b[31m\x1b[32mab\x1b[0m", "\x1b[32mcd\x1b[0m"])
  expect(wrapText("\x1b[4:3mab\x1b[4:0m cd", 2)).toEqual(["\x1b[4:3mab\x1b[4:0m", "cd"])
})

test("a break after zero-width text does not leave the rest of the row too wide", () => {
  // The head before the space takes no cells, so breaking there would gain nothing.
  expect(wrapText("​ ab中", 3)).toEqual(["​ ab", "中"])
  expect(wrapText("́ ab中", 3)).toEqual(["́ ab", "中"])
})

/** A small deterministic PRNG (mulberry32), so a failure can be replayed. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

test("wrapped rows fit the width and keep every character but the spaces at breaks", () => {
  const pieces = ["a", "bc", "word", " ", "  ", "中", "文字", "😀", "é", "​", "́", "\t", "\x1b[1m", "\x1b[0m"]
  const rand = rng(1)
  const kept = (s: string) => stripAnsi(s).replace(/[ \t]/g, "")
  for (let i = 0; i < 5000; i++) {
    let text = ""
    for (let n = 1 + Math.floor(rand() * 10); n > 0; n--) text += pieces[Math.floor(rand() * pieces.length)]
    const width = 1 + Math.floor(rand() * 40)
    const rows = wrapText(text, width)
    for (const r of rows) {
      // A single character wider than the row is the only thing that may stick out.
      const fits = visibleWidth(r) <= width || graphemes(stripAnsi(r)).length === 1
      expect({ text, width, r, fits }).toEqual({ text, width, r, fits: true })
    }
    expect({ text, width, kept: kept(rows.join("")) }).toEqual({ text, width, kept: kept(text) })
  }
})
