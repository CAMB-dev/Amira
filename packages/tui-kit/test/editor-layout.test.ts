import { expect, test } from "bun:test"
import { CURSOR_MARKER } from "../src/component.ts"
import { Editor } from "../src/components/editor.ts"
import { key, textKey } from "../src/keys.ts"
import { graphemes, TAB_WIDTH, textWidth } from "../src/width.ts"
import { plain } from "./context.ts"

/**
 * The layout from scratch: every line wrapped at its last space that fits (a word longer than a
 * row is split where the row ends). The incremental editor must draw exactly what this draws,
 * whatever happened before.
 */
function reference(lines: string[], caret: { line: number; col: number }, width: number, prompt: string) {
  const pw = prompt.length
  const max = Math.max(2, width - pw)
  const cell = (g: string, used: number) =>
    g === "\t" ? TAB_WIDTH - ((pw + used) % TAB_WIDTH) : textWidth(g)
  const rows: { line: number; start: number; end: number; last: boolean }[] = []
  const space = (g: string) => g === " " || g === "\t"
  lines.forEach((text, line) => {
    const gs = graphemes(text)
    let start = 0
    let used = 0
    let pos = 0
    let breakAt = -1
    let breakPos = 0
    let i = 0
    while (i < gs.length) {
      const g = gs[i]!
      const w = cell(g, used)
      if (used + w > max && pos > start) {
        if (breakAt !== -1 && breakPos > start && !space(g)) {
          i = breakAt
          pos = breakPos
        }
        rows.push({ line, start, end: pos, last: false })
        start = pos
        used = 0
        breakAt = -1
        continue
      }
      used += w
      pos += g.length
      i++
      if (space(g)) {
        breakAt = i
        breakPos = pos
      }
    }
    if (used >= max && line === caret.line && caret.col === text.length) {
      rows.push({ line, start, end: pos, last: false })
      start = pos
    }
    rows.push({ line, start, end: pos, last: true })
  })
  const at = rows.findIndex(
    (r) =>
      r.line === caret.line && caret.col >= r.start && (caret.col < r.end || (r.last && caret.col === r.end)),
  )
  return rows.map((r, i) => {
    let body = lines[r.line]!.slice(r.start, r.end)
    if (i === at) body = `${body.slice(0, caret.col - r.start)}|${body.slice(caret.col - r.start)}`
    return (i === 0 ? prompt : " ".repeat(pw)) + body
  })
}

/** A small deterministic PRNG, so a failure can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

test("incremental layout draws what a full layout draws, after any sequence of edits", () => {
  const pieces = ["a", "bc", "你", "😀", "\t", " ", "xyz ", "é", "ab\ncd", "\n"]
  const keys = ["backspace", "delete", "left", "right", "up", "down", "home", "end"]
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng(seed)
    const ed = new Editor({ prompt: "> " })
    let width = 8
    for (let step = 0; step < 300; step++) {
      const r = rand()
      if (r < 0.5) ed.handleInput(textKey(pieces[Math.floor(rand() * pieces.length)]!))
      else if (r < 0.55) ed.handleInput({ type: "paste", text: "p1\np2 long line here\n" })
      else if (r < 0.6) width = 5 + Math.floor(rand() * 12)
      else if (r < 0.62) ed.setText("fresh\ntext")
      else {
        const name = keys[Math.floor(rand() * keys.length)]!
        ed.handleInput(key(name, rand() < 0.2 ? { ctrl: true } : {}))
      }
      const drawn = ed.render(width, plain).map((l) => l.replace(CURSOR_MARKER, "|"))
      const lines = ed.getText().split("\n")
      const want = reference(lines, ed.cursor, width, "> ")
      if (drawn.join("\n") !== want.join("\n")) {
        throw new Error(
          `seed ${seed} step ${step}:\n${drawn.join("\n")}\n--- expected ---\n${want.join("\n")}`,
        )
      }
      expect(ed.hidden).toEqual({ above: 0, below: 0 })
    }
  }
})

test("getText is cached until the text changes", () => {
  const ed = new Editor()
  ed.setText("a\nb")
  const first = ed.getText()
  expect(ed.getText()).toBe(first)
  ed.handleInput(textKey("c"))
  expect(ed.getText()).toBe("a\nbc")
  expect(ed.isEmpty).toBe(false)
  expect(ed.lineCount).toBe(2)
  ed.clear()
  expect(ed.isEmpty).toBe(true)
})

test("version counts changes, setText included, but not caret moves", () => {
  const ed = new Editor()
  const v0 = ed.version
  ed.setText("hi")
  const v1 = ed.version
  expect(v1).toBeGreaterThan(v0)
  ed.handleInput(key("left"))
  expect(ed.version).toBe(v1)
  ed.handleInput(textKey("x"))
  expect(ed.version).toBeGreaterThan(v1)
})

test("textBeforeCaret and replaceBeforeCaret edit the word being typed", () => {
  const ed = new Editor()
  ed.setText("see @sr and more")
  for (let i = 0; i < " and more".length; i++) ed.handleInput(key("left"))
  expect(ed.textBeforeCaret()).toBe("see @sr")
  ed.replaceBeforeCaret(3, "@src/app.ts")
  expect(ed.getText()).toBe("see @src/app.ts and more")
  expect(ed.cursor).toEqual({ line: 0, col: "see @src/app.ts".length })
})

test("a replaceBeforeCaret undoes and redoes as one change", () => {
  const ed = new Editor()
  ed.setText("see @sr and more")
  for (let i = 0; i < " and more".length; i++) ed.handleInput(key("left"))
  ed.replaceBeforeCaret(3, "@src/app.ts ")
  ed.undo()
  expect(ed.getText()).toBe("see @sr and more")
  expect(ed.cursor).toEqual({ line: 0, col: "see @sr".length })
  ed.redo()
  expect(ed.getText()).toBe("see @src/app.ts  and more")
  ed.undo()
  ed.undo()
  expect(ed.getText()).toBe("")
})

/** Milliseconds per call of `fn`, the median of `n` runs. */
function perCall(n: number, fn: () => void): number {
  const times: number[] = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(n / 2)]!
}

test("a key costs well under a frame with 100k lines of text", () => {
  const ed = new Editor({ prompt: "> " })
  ed.maxRows = 10
  const lines = Array.from({ length: 100_000 }, (_, i) => `line ${i} of a long pasted log, with some words`)
  ed.setText(lines.join("\n"))
  ed.render(80, plain)
  const frame = (e: Parameters<Editor["handleInput"]>[0]) => () => {
    ed.handleInput(e)
    ed.render(80, plain)
    ed.getText()
  }
  // The target is 16 ms per key; the bound is generous so a loaded CI machine does not flake.
  const bound = 40
  expect(perCall(30, frame(textKey("x")))).toBeLessThan(bound)
  expect(perCall(30, frame(key("up")))).toBeLessThan(bound)
  expect(perCall(30, frame(key("backspace")))).toBeLessThan(bound)
  // Editing near the top shifts the rows of every line below it.
  ed.handleInput(key("home"))
  for (let i = 0; i < 99_990; i++) ed.handleInput(key("up"))
  ed.render(80, plain)
  expect(perCall(30, frame(textKey("y")))).toBeLessThan(bound)
  const before = ed.lineCount
  expect(perCall(10, frame(key("enter", { shift: true })))).toBeLessThan(bound)
  expect(ed.getText().split("\n").length).toBe(before + 10)
})
