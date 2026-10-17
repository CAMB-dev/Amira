import { expect, test } from "bun:test"
import { Editor, Form, type MouseInput, textKey } from "../src/index.ts"
import { plain } from "./context.ts"

test("editor cell placement respects wide graphemes, combining marks and prompt width", () => {
  const editor = new Editor({ prompt: "> " })
  editor.setText("a界é👍z")
  editor.render(30, plain)
  editor.placeCursor(4, 0)
  expect(editor.cursor).toEqual({ line: 0, col: 1 })
  editor.placeCursor(5, 0)
  expect(editor.cursor).toEqual({ line: 0, col: 2 })
  editor.placeCursor(6, 0)
  expect(editor.cursor).toEqual({ line: 0, col: 4 })
  editor.placeCursor(7, 0)
  expect(editor.cursor).toEqual({ line: 0, col: 4 })
  editor.placeCursor(8, 0)
  expect(editor.cursor).toEqual({ line: 0, col: 6 })
})

test("form textarea clicks place the caret on the clicked rendered row", () => {
  const form = new Form({
    title: "Notes",
    fields: [{ id: "note", type: "textarea", label: "Note" }],
    values: { note: "first\n界second" },
    onSubmit: () => {},
    onCancel: () => {},
  })
  const rows = form.render(60, { ...plain, rows: 20 })
  const y = rows.findIndex((line) => line.includes("界second"))
  const x = rows[y]!.indexOf("界second") + 2
  const event: MouseInput = {
    type: "mouse",
    action: "press",
    button: "left",
    x,
    y,
    ctrl: false,
    shift: false,
    alt: false,
  }
  form.handleInput(event)
  form.handleInput({ ...event, action: "release" })
  form.handleInput(textKey("!"))
  expect(form.values.note).toBe("first\n界!second")
})

test("editor cell placement follows wrapping and the last scrolled viewport", () => {
  const editor = new Editor()
  editor.maxRows = 2
  editor.setText("0123456789\nsecond\nthird")
  editor.render(6, plain)
  expect(editor.hidden.above).toBeGreaterThan(0)
  editor.placeCursor(2, 0)
  expect(editor.cursor).toEqual({ line: 1, col: 2 })
  editor.setCursor({ line: 0, col: 0 })
  editor.render(6, plain)
  editor.placeCursor(2, 1)
  expect(editor.cursor).toEqual({ line: 0, col: 8 })
})
