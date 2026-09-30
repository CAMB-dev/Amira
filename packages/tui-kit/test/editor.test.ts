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

test("Enter on an empty editor does not submit and is left unhandled; setText does not report a change", () => {
  const submitted: string[] = []
  const changes: string[] = []
  const ed = new Editor({ onSubmit: (t) => submitted.push(t), onChange: (t) => changes.push(t) })
  expect(press(ed, "enter")).toBe(false)
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

test("a paste of hundreds of thousands of lines does not overflow the stack", () => {
  const ed = new Editor()
  type(ed, "x")
  ed.handleInput({ type: "paste", text: "a\n".repeat(700_000) })
  expect(ed.cursor).toEqual({ line: 700_000, col: 0 })
  expect(ed.getText().length).toBe(1 + 2 * 700_000)
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

test("a grapheme longer than the look-around window still moves and deletes whole", () => {
  const cluster = `a${"́".repeat(200)}`
  const ed = new Editor()
  ed.setText(`${cluster}b`)
  press(ed, "left")
  press(ed, "left")
  expect(ed.cursor).toEqual({ line: 0, col: 0 })
  press(ed, "right")
  expect(ed.cursor).toEqual({ line: 0, col: cluster.length })
  press(ed, "backspace")
  expect(ed.getText()).toBe("b")
  ed.setText(`x${cluster}`)
  press(ed, "home")
  press(ed, "right")
  press(ed, "delete")
  expect(ed.getText()).toBe("x")
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

test("tabs reach the next 4-column stop of the drawn line, prompt included", () => {
  const ed = new Editor({ prompt: "> " })
  ed.setText("a\tb")
  const [row] = ed.render(40, plain)
  // "> a" ends at column 3, so the tab takes one cell and "b" ends at column 5.
  expect(visibleWidth(row!.slice(0, row!.indexOf(CURSOR_MARKER)))).toBe(5)
  // With 6 content cells the tabs take 2 and 4, so "ab" wraps to the next row.
  ed.setText("\t\tab")
  expect(view(ed, 8)).toEqual(["> \t\t", "  ab|"])
})

test("up/down keep the display column across tabs", () => {
  const ed = new Editor({ prompt: "> " })
  ed.setText("\tx\nabcdefgh")
  press(ed, "up")
  press(ed, "end")
  // The tab takes cells 2-3 of the line, so the caret after "x" is 3 cells into the row.
  press(ed, "down")
  expect(ed.cursor).toEqual({ line: 1, col: 3 })
  press(ed, "right")
  press(ed, "up")
  expect(ed.cursor).toEqual({ line: 0, col: 2 })
  press(ed, "home")
  press(ed, "right")
  press(ed, "down")
  expect(ed.cursor).toEqual({ line: 1, col: 2 })
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

test("past maxRows the text scrolls inside the editor, keeping the caret in view", () => {
  const ed = new Editor({ prompt: "> " })
  ed.maxRows = 3
  ed.setText(["one", "two", "three", "four", "five"].join("\n"))
  expect(view(ed)).toEqual(["  three", "  four", "  five|"])
  expect(ed.hidden).toEqual({ above: 2, below: 0 })
  // Moving inside the shown rows does not scroll; moving past them scrolls a row at a time.
  press(ed, "up")
  press(ed, "up")
  expect(view(ed)).toEqual(["  thre|e", "  four", "  five"])
  press(ed, "up")
  expect(view(ed)).toEqual(["  two|", "  three", "  four"])
  expect(ed.hidden).toEqual({ above: 1, below: 1 })
  press(ed, "up")
  expect(view(ed)).toEqual(["> one|", "  two", "  three"])
  expect(ed.hidden).toEqual({ above: 0, below: 2 })
  // Wrapped rows count as rows, the caret's own empty row included.
  ed.setText("abcdefghijklmnop")
  expect(view(ed, 6)).toEqual(["  ijkl", "  mnop", "  |"])
  expect(ed.hidden).toEqual({ above: 2, below: 0 })
})

test("when the text gets shorter the shown rows stay full", () => {
  const ed = new Editor()
  ed.maxRows = 2
  ed.setText("a\nb\nc\nd")
  expect(view(ed)).toEqual(["c", "d|"])
  press(ed, "up")
  press(ed, "up")
  expect(view(ed)).toEqual(["b|", "c"])
  ed.setText("a\nb")
  expect(view(ed)).toEqual(["a", "b|"])
  ed.setText("a")
  expect(view(ed)).toEqual(["a|"])
  expect(ed.hidden).toEqual({ above: 0, below: 0 })
})

test("the submit and newline keys can be replaced", () => {
  const sent: string[] = []
  const ed = new Editor({
    onSubmit: (t) => sent.push(t),
    isSubmit: (e) => e.type === "key" && e.name === "s" && e.ctrl,
    isNewline: (e) => e.type === "key" && e.name === "enter" && !e.ctrl && !e.alt && !e.shift,
  })
  type(ed, "a\rb")
  expect(ed.getText()).toBe("a\nb")
  // Shift+Enter is no longer a newline key, and inserts nothing.
  expect(press(ed, "enter", { shift: true })).toBe(false)
  press(ed, "s", { ctrl: true })
  expect(sent).toEqual(["a\nb"])
})

test("long lines wrap at the last space that fits, like the transcript; a long word is split", () => {
  const ed = new Editor({ prompt: "> " })
  ed.setText("the quick brown fox jumps")
  expect(view(ed, 14)).toEqual(["> the quick ", "  brown fox ", "  jumps|"])
  ed.setText("abcdefghijklmnop")
  expect(view(ed, 10)).toEqual(["> abcdefgh", "  ijklmnop", "  |"])
  // Not ASCII: the same rule.
  ed.setText("héllo wörld again")
  expect(view(ed, 10)).toEqual(["> héllo ", "  wörld ", "  again|"])
})

test("a placeholder longer than the row is cut to it", () => {
  const ed = new Editor({ prompt: "> ", placeholder: "Message Amira about anything at all" })
  const [row] = ed.render(12, plain)
  expect(visibleWidth(row!.replace(CURSOR_MARKER, ""))).toBeLessThanOrEqual(12)
  expect(row!.replace(CURSOR_MARKER, "")).toBe("> Message A…")
})

test("undo takes back a word of typing at once, and redo brings it again", () => {
  const ed = new Editor()
  type(ed, "hello world")
  expect(ed.undo()).toBe(true)
  expect(ed.getText()).toBe("hello ")
  ed.undo()
  expect(ed.getText()).toBe("hello")
  ed.undo()
  expect(ed.getText()).toBe("")
  expect(ed.undo()).toBe(false)
  ed.redo()
  ed.redo()
  ed.redo()
  expect(ed.getText()).toBe("hello world")
  // Backspaces in a row are one step; a new change drops what could be redone.
  press(ed, "backspace")
  press(ed, "backspace")
  ed.undo()
  expect(ed.getText()).toBe("hello world")
  type(ed, "!")
  expect(ed.redo()).toBe(false)
  // What was sent is not undone into the next message.
  const sent = new Editor({ onSubmit: () => {} })
  type(sent, "go")
  press(sent, "enter")
  expect(sent.undo()).toBe(false)
})

test("the kill keys cut into a ring that yank pastes back; kills in a row join", () => {
  const ed = new Editor()
  type(ed, "one two three")
  ed.killWordBefore()
  ed.killWordBefore()
  expect(ed.getText()).toBe("one ")
  ed.yank()
  expect(ed.getText()).toBe("one two three")
  press(ed, "home")
  ed.killToLineEnd()
  expect(ed.getText()).toBe("")
  ed.yank()
  ed.yank()
  expect(ed.getText()).toBe("one two threeone two three")
  press(ed, "left")
  ed.killToLineStart()
  expect(ed.getText()).toBe("e")
  // Undo brings back what a kill cut, and takes back a yank at once.
  ed.undo()
  expect(ed.getText()).toBe("one two threeone two three")
  ed.undo()
  expect(ed.getText()).toBe("one two three")
})

test("only kills in a row join: a yank, undo or other change in between starts a new cut", () => {
  const ed = new Editor()
  type(ed, "one two")
  ed.killWordBefore()
  ed.yank()
  ed.killWordBefore()
  ed.yank()
  expect(ed.getText()).toBe("one two")
  ed.killWordBefore()
  ed.undo()
  ed.killWordBefore()
  ed.yank()
  expect(ed.getText()).toBe("one two")
  ed.killWordBefore()
  ed.insert("x")
  ed.killWordBefore()
  ed.yank()
  expect(ed.getText()).toBe("one x")
  ed.setCursor({ line: 0, col: 3 })
  ed.killWordBefore()
  ed.setCursor({ line: 0, col: Infinity })
  ed.killWordBefore()
  ed.yank()
  expect(ed.getText()).toBe(" x")
  // Text the app puts in (a history entry, a cleared prompt) ends the run too.
  ed.setText("one two")
  ed.killWordBefore()
  ed.setText("three four")
  ed.killWordBefore()
  ed.yank()
  expect(ed.getText()).toBe("three four")
})

test("a folded paste cut and yanked back stays folded", () => {
  const ed = new Editor({ foldPastes: { lines: 2, chars: 1000 } })
  type(ed, "see ")
  ed.handleInput({ type: "paste", text: "a\nb\nc" })
  ed.killToLineStart()
  expect(ed.getText()).toBe("")
  ed.yank()
  expect(ed.getText()).toBe("see a\nb\nc")
  expect(ed.getDisplayText()).toMatch(/^see \[pasted 3 lines #\d\]$/)
})

test("the caret's row as drawn: first and last rows of a wrapped line", () => {
  const ed = new Editor({ prompt: "> " })
  ed.setText("aaaa bbbb cccc")
  view(ed, 8)
  expect(ed.onLastRow).toBe(true)
  expect(ed.onFirstRow).toBe(false)
  ed.setCursor({ line: 0, col: 0 })
  expect(ed.onFirstRow).toBe(true)
  expect(ed.onLastRow).toBe(false)
})
