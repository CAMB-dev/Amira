import { expect, test } from "bun:test"
import { defaultGlyphs, Editor, key, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { CURSOR_MARKER } from "../../tui-kit/src/component.ts"
import { plain } from "../../tui-kit/test/context.ts"
import { InputBox } from "../src/input-box.ts"

test("composer pads the marker and keeps the placeholder caret on the text column", () => {
  const editor = new Editor({ prompt: "› ", placeholder: "Message Amira" })
  const rows = new InputBox(editor).render(30, plain)
  expect(stripAnsi(rows[1]!)).toStartWith("│ › Message Amira")
  const [before] = rows[1]!.split(CURSOR_MARKER)
  expect(visibleWidth(before!)).toBe(4)
})

test("wrapped and explicit continuation rows keep the text and caret clear of both sides", () => {
  const editor = new Editor({ prompt: "› " })
  const box = new InputBox(editor)
  editor.setText("abcdefgh\n你好")
  const rows = box.render(12, plain)
  expect(rows.map(stripAnsi)).toEqual([
    "╭──────────╮",
    "│ › abcdef │",
    "│   gh     │",
    "│   你好   │",
    "╰──────────╯",
  ])
  expect(visibleWidth(rows[3]!.split(CURSOR_MARKER)[0]!)).toBe(8)
  expect(rows.every((row) => visibleWidth(row) === 12)).toBe(true)
})

test("narrow and short composers keep their bare-editor fallbacks", () => {
  for (const width of [1, 2, 7, 8, 12]) {
    for (const budget of [1, 2, 3, 4]) {
      const editor = new Editor({ prompt: "› ", placeholder: "Message Amira" })
      const box = new InputBox(editor)
      box.maxRows = budget
      const rows = box.render(width, plain)
      const framed = width >= 8 && budget >= 4
      const row = rows[framed ? 1 : 0]!
      expect(stripAnsi(row)).toStartWith(framed ? "│ › " : "› ")
      expect(visibleWidth(row.split(CURSOR_MARKER)[0]!)).toBe(framed ? 4 : 2)
      // The editor itself preserves its prompt even below the prompt's width.
      expect(rows.every((row) => visibleWidth(row) <= Math.max(3, width))).toBe(true)
    }
  }
})

test("ASCII composer keeps padding, scroll labels and the separate status row", () => {
  const ctx = {
    ...plain,
    rows: 9,
    glyphs: {
      ...defaultGlyphs,
      pointer: ">",
      codeSide: "|",
      rule: "-",
      boxTopLeft: "+",
      boxTopRight: "+",
      boxBottomLeft: "+",
      boxBottomRight: "+",
    },
  }
  const editor = new Editor({ prompt: "> " })
  const box = new InputBox(editor, () => [
    { id: "status", text: "ready", align: "left", priority: 1, tone: "muted" },
  ])
  editor.setText(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"))
  const bottom = box.render(30, ctx).map(stripAnsi)
  expect(bottom[0]).toContain("up 9 rows")
  expect(bottom[1]).toStartWith("|   line 9")
  expect(bottom.at(-1)).toStartWith("  ready")
  for (let i = 0; i < 12; i++) editor.handleInput(key("up"))
  const top = box.render(30, ctx).map(stripAnsi)
  expect(top[1]).toStartWith("| > line 0")
  expect(top.at(-1)).toContain("down 9 rows")
  expect(top.at(-2)).toBe(`+${"-".repeat(28)}+`)
  expect(top.every((row) => visibleWidth(row) === 30)).toBe(true)
})
