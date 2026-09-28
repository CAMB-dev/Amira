import { expect, test } from "bun:test"
import type { RenderContext } from "../src/component.ts"
import { StreamText } from "../src/components/stream-text.ts"
import { visibleWidth, wrapText } from "../src/width.ts"
import { plain } from "./context.ts"

/** A render context whose commits are collected, like the renderer's during a frame. */
function committing(): { ctx: RenderContext; committed: string[] } {
  const committed: string[] = []
  return { ctx: { ...plain, commit: (lines) => committed.push(...lines) }, committed }
}

/** Deterministic pseudo-random numbers, so a failing case can be replayed. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
}

const PIECES = [
  "word",
  "lengthy",
  "a",
  "supercalifragilistic",
  "你好",
  "世界和平",
  "👍",
  "é",
  "é",
  " ",
  " ",
  "  ",
  "\n",
  "\n\n",
  "\t",
]

function randomText(rand: () => number, pieces: number): string {
  let s = ""
  for (let i = 0; i < pieces; i++) s += PIECES[Math.floor(rand() * PIECES.length)]
  return s
}

test("wraps at spaces and after wide characters, and hard-breaks long words", () => {
  const t = new StreamText()
  t.append("hello world again")
  expect(t.render(11, plain)).toEqual(["hello world", "again"])
  const cjk = new StreamText()
  cjk.append("你好世界你好")
  expect(cjk.render(5, plain)).toEqual(["你好", "世界", "你好"])
  const long = new StreamText()
  long.append("abcdefghij kl")
  expect(long.render(4, plain)).toEqual(["abcd", "efgh", "ij", "kl"])
  expect(new StreamText().render(10, plain)).toEqual([])
})

test("drops leading whitespace, escape sequences and control characters; expands tabs", () => {
  const t = new StreamText()
  t.append("\n\n  ")
  expect(t.getText()).toBe("")
  t.append("\x1b[31mred\x1b[0m\r\nx\ty\x07")
  expect(t.getText()).toBe("red\nx   y")
})

test("rows that no longer fit are committed as shown; the row being written stays", () => {
  const { ctx, committed } = committing()
  const t = new StreamText()
  t.maxRows = 3
  t.append("one two three four five six seven")
  expect(t.render(9, ctx)).toEqual(["one two", "three", "four five", "six seven"].slice(3))
  expect(committed).toEqual(["one two", "three", "four five"])
  expect(t.committedRows).toBe(3)
  t.append(" eight")
  expect(t.render(9, ctx)).toEqual(["six seven", "eight"])
  expect(committed).toHaveLength(3)
})

test("without a commit callback nothing is committed", () => {
  const t = new StreamText()
  t.maxRows = 1
  t.append("a\nb\nc")
  expect(t.render(10, plain)).toEqual(["a", "b", "c"])
  expect(t.committedRows).toBe(0)
})

test("blank rows at the end are not committed early, and take drops them", () => {
  const { ctx, committed } = committing()
  const t = new StreamText()
  t.maxRows = 2
  t.append("a\nb\n\n\nc")
  t.render(10, ctx)
  expect(committed).toEqual(["a", "b"])
  expect(t.take(10)).toEqual(["", "", "c"])
  t.append("x\n\n")
  expect(t.take(10)).toEqual(["x"])
  expect(t.committedRows).toBe(0)
})

test("streamed in any chunks, committed rows plus the rest are the rows of the whole text", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rand = rng(seed)
    const text = randomText(rand, 60)
    const width = 3 + Math.floor(rand() * 20)
    const whole = new StreamText()
    whole.append(text)
    const expected = whole.take(width)

    const { ctx, committed } = committing()
    const t = new StreamText()
    // Streams split between code points, not inside a surrogate pair.
    const points = Array.from(text)
    let at = 0
    while (at < points.length) {
      const n = 1 + Math.floor(rand() * 7)
      t.append(points.slice(at, at + n).join(""))
      at += n
      t.maxRows = 1 + Math.floor(rand() * 4)
      const live = t.render(width, ctx)
      expect(live.every((r) => visibleWidth(r) <= width)).toBe(true)
    }
    expect({ seed, rows: [...committed, ...t.take(width)] }).toEqual({ seed, rows: expected })
  }
})

test("a width change mid-stream re-wraps only the live rows and loses nothing", () => {
  const rand = rng(7)
  const text = randomText(rand, 200)
  const { ctx, committed } = committing()
  const t = new StreamText()
  for (let at = 0; at < text.length; at += 5) {
    t.append(text.slice(at, at + 5))
    t.maxRows = 3
    t.render(at % 50 < 25 ? 12 : 7, ctx)
  }
  const rows = [...committed, ...t.take(9)]
  const words = (s: string) => s.split(/\s+/).filter(Boolean).join("")
  expect(words(rows.join(" "))).toBe(words(text))
})

test("matches wrapText for plain prose", () => {
  const text = "The quick brown fox jumps over the lazy dog, then naps in the sun for a while."
  const t = new StreamText()
  t.append(text)
  expect(t.render(17, plain)).toEqual(wrapText(text, 17))
})
