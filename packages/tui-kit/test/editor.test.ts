import { expect, test } from "bun:test"
import { CURSOR_MARKER } from "../src/component.ts"
import { Editor } from "../src/components/editor.ts"
import { InputParser } from "../src/input.ts"
import { type InputEvent, key } from "../src/keys.ts"
import { visibleWidth } from "../src/width.ts"
import { plain } from "./context.ts"

function type(ed: Editor, raw: string) {
  for (const e of new InputParser().feed(raw)) ed.handleInput(e)
}

function press(ed: Editor, name: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) {
  return ed.handleInput(key(name, mods))
}

/** Renders and returns the rows with the caret shown as "|". */
function view(ed: Editor, width = 40): string[] {
  return ed.render(width, plain).map((l) => l.replace(CURSOR_MARKER, "|"))
}

test("typing, backspace and delete", () => {
  const ed = new Editor()
  type(ed, "hello")
  press(ed, "backspace")
  expect(ed.getText()).toBe("hell")
  press(ed, "home")
  press(ed, "delete")
  expect(ed.getText()).toBe("ell")
  expect(ed.cursor).toEqual({ line: 0, col: 0 })
})

test("Enter submits and clears; the newline key inserts a line break", () => {
  const submitted: string[] = []
  const ed = new Editor({ onSubmit: (t) => submitted.push(t) })
  type(ed, "a")
  press(ed, "enter", { shift: true })
  type(ed, "b")
  press(ed, "enter", { ctrl: true })
  type(ed, "c")
  expect(ed.getText()).toBe("a\nb\nc")
  press(ed, "enter")
  expect(submitted).toEqual(["a\nb\nc"])
  expect(ed.getText()).toBe("")
})

test("Enter on an empty editor does not submit; setText does not report a change", () => {
  const submitted: string[] = []
  const changes: string[] = []
  const ed = new Editor({ onSubmit: (t) => submitted.push(t), onChange: (t) => changes.push(t) })
  expect(press(ed, "enter")).toBe(true)
  expect(submitted).toEqual([])
  ed.setText("draft")
  ed.clear()
  expect(changes).toEqual([])
  type(ed, "a")
  expect(changes).toEqual(["a"])
})

test("legacy Ctrl+Enter (\\n) inserts a newline, \\r submits", () => {
  const submitted: string[] = []
  const ed = new Editor({ onSubmit: (t) => submitted.push(t) })
  type(ed, "x\ny\r")
  expect(submitted).toEqual(["x\ny"])
})

test("paste inserts text with newlines at the caret", () => {
  const ed = new Editor()
  type(ed, "[]")
  press(ed, "left")
  ed.handleInput({ type: "paste", text: "one\ntwo" } satisfies InputEvent)
  expect(ed.getText()).toBe("[one\ntwo]")
  expect(ed.cursor).toEqual({ line: 1, col: 3 })
})

test("left/right cross line boundaries; backspace at line start joins lines", () => {
  const ed = new Editor()
  ed.setText("ab\ncd")
  press(ed, "home")
  press(ed, "left")
  expect(ed.cursor).toEqual({ line: 0, col: 2 })
  press(ed, "right")
  expect(ed.cursor).toEqual({ line: 1, col: 0 })
  press(ed, "backspace")
  expect(ed.getText()).toBe("abcd")
  expect(ed.cursor).toEqual({ line: 0, col: 2 })
  press(ed, "end")
  press(ed, "delete")
  expect(ed.getText()).toBe("abcd")
})

test("up/down keep the display column, including across CJK", () => {
  const ed = new Editor()
  ed.setText("你好世界\nabcdefgh")
  expect(ed.cursor).toEqual({ line: 1, col: 8 })
  press(ed, "left")
  press(ed, "left")
  press(ed, "left")
  expect(press(ed, "up")).toBe(true)
  // Column 5 lands inside 世 (cols 4-5), so the caret goes before it.
  expect(ed.cursor).toEqual({ line: 0, col: 2 })
  press(ed, "down")
  expect(ed.cursor).toEqual({ line: 1, col: 5 })
  expect(press(ed, "down")).toBe(false)
})

test("CJK and emoji: the caret moves by whole characters and sits at the right column", () => {
  const ed = new Editor({ prompt: "> " })
  type(ed, "a你😀b")
  press(ed, "left")
  press(ed, "left")
  expect(ed.cursor).toEqual({ line: 0, col: 2 })
  const [row] = ed.render(40, plain)
  expect(visibleWidth(row!.slice(0, row!.indexOf(CURSOR_MARKER)))).toBe(5)
  press(ed, "backspace")
  expect(ed.getText()).toBe("a😀b")
  press(ed, "delete")
  expect(ed.getText()).toBe("ab")
})

test("IME text from win32-input-mode is inserted", () => {
  const ed = new Editor()
  type(ed, "\x1b[0;0;20320;1;0;1_\x1b[0;0;22909;1;0;1_")
  expect(ed.getText()).toBe("你好")
})

test("word-wise movement and deletion", () => {
  const ed = new Editor()
  ed.setText("foo bar  baz")
  press(ed, "left", { ctrl: true })
  expect(ed.cursor.col).toBe(9)
  press(ed, "left", { ctrl: true })
  expect(ed.cursor.col).toBe(4)
  press(ed, "right", { ctrl: true })
  expect(ed.cursor.col).toBe(7)
  press(ed, "backspace", { ctrl: true })
  expect(ed.getText()).toBe("foo   baz")
})

test("renders the prompt, wraps long lines and marks the caret", () => {
  const ed = new Editor({ prompt: "> " })
  ed.setText("abcdefghij")
  expect(view(ed, 7)).toEqual(["> abcde", "  fghij", "  |"])
  press(ed, "home")
  expect(view(ed, 7)).toEqual(["> |abcde", "  fghij"])
  ed.setText("你好世界你")
  expect(view(ed, 7)).toEqual(["> 你好", "  世界", "  你|"])
})

test("up/down move between wrapped rows of one line", () => {
  const ed = new Editor()
  ed.setText("abcdefghij")
  ed.render(4, plain)
  press(ed, "up")
  expect(ed.cursor).toEqual({ line: 0, col: 6 })
  press(ed, "up")
  expect(ed.cursor).toEqual({ line: 0, col: 2 })
  expect(press(ed, "up")).toBe(false)
  press(ed, "down")
  press(ed, "down")
  expect(ed.cursor).toEqual({ line: 0, col: 10 })
})

test("placeholder when empty, no caret marker when unfocused", () => {
  const ed = new Editor({ prompt: "> ", placeholder: "Ask anything" })
  expect(view(ed)).toEqual(["> |Ask anything"])
  ed.focused = false
  type(ed, "x")
  expect(view(ed)).toEqual(["> x"])
})

test("unhandled keys return false", () => {
  const ed = new Editor()
  expect(press(ed, "f5")).toBe(false)
  expect(press(ed, "c", { ctrl: true })).toBe(false)
})
