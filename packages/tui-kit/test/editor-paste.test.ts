import { expect, test } from "bun:test"
import { CURSOR_MARKER } from "../src/component.ts"
import { defaultPasteLabel, Editor, type SubmitInfo } from "../src/components/editor.ts"
import { key, textKey } from "../src/keys.ts"
import { plain } from "./context.ts"

const fold = { lines: 8, chars: 1000 }
const tenLines = Array.from({ length: 10 }, (_, i) => `row ${i}`).join("\n")

function view(ed: Editor, width = 60): string[] {
  return ed.render(width, plain).map((l) => l.replace(CURSOR_MARKER, "|"))
}

test("a big paste becomes one placeholder that expands in getText", () => {
  const ed = new Editor({ prompt: "> ", foldPastes: fold })
  ed.handleInput(textKey("see "))
  ed.handleInput({ type: "paste", text: tenLines })
  ed.handleInput(textKey(" ok"))
  expect(view(ed)).toEqual(["> see [pasted 10 lines #1] ok|"])
  expect(ed.getText()).toBe(`see ${tenLines} ok`)
  expect(ed.getDisplayText()).toBe("see [pasted 10 lines #1] ok")
  expect(ed.lineCount).toBe(1)
})

test("small pastes are inserted as text; long single lines fold by characters", () => {
  const ed = new Editor({ foldPastes: fold })
  ed.handleInput({ type: "paste", text: "one\ntwo" })
  expect(ed.getDisplayText()).toBe("one\ntwo")
  ed.clear()
  ed.handleInput({ type: "paste", text: "x".repeat(1500) })
  expect(ed.getDisplayText()).toBe("[pasted 1500 chars #1]")
  // Seven lines and a trailing line break are still seven lines.
  ed.clear()
  ed.handleInput({ type: "paste", text: "a\n".repeat(7) })
  expect(ed.getDisplayText()).toBe("a\n".repeat(7))
  ed.clear()
  ed.handleInput({ type: "paste", text: "a\r\n".repeat(8) })
  expect(ed.getDisplayText()).toBe("[pasted 8 lines #1]")
  expect(ed.getText()).toBe("a\n".repeat(8))
})

test("without foldPastes every paste is inserted as text", () => {
  const ed = new Editor()
  ed.handleInput({ type: "paste", text: tenLines })
  expect(ed.getDisplayText()).toBe(tenLines)
})

test("the caret steps over a placeholder and backspace deletes it whole", () => {
  const ed = new Editor({ foldPastes: fold })
  ed.handleInput(textKey("a"))
  ed.handleInput({ type: "paste", text: tenLines })
  ed.handleInput(textKey("b"))
  ed.handleInput(key("left"))
  ed.handleInput(key("left"))
  expect(view(ed)).toEqual(["a|[pasted 10 lines #1]b"])
  ed.handleInput(key("right"))
  expect(view(ed)).toEqual(["a[pasted 10 lines #1]|b"])
  ed.handleInput(key("backspace"))
  expect(ed.getText()).toBe("ab")
  expect(ed.getParts()).toEqual(["ab"])
  ed.handleInput({ type: "paste", text: tenLines })
  ed.handleInput(key("home"))
  ed.handleInput(key("right"))
  ed.handleInput(key("delete"))
  expect(ed.getText()).toBe("ab")
})

test("placeholders are numbered, and numbering restarts once the editor is emptied", () => {
  const ed = new Editor({ foldPastes: fold })
  ed.handleInput({ type: "paste", text: tenLines })
  ed.handleInput({ type: "paste", text: `${tenLines}\nmore` })
  expect(ed.getDisplayText()).toBe("[pasted 10 lines #1][pasted 11 lines #2]")
  ed.clear()
  ed.handleInput({ type: "paste", text: tenLines })
  expect(ed.getDisplayText()).toBe("[pasted 10 lines #1]")
})

test("submit hands over the expanded text, the display form and the parts", () => {
  const got: [string, SubmitInfo][] = []
  const ed = new Editor({ foldPastes: fold, onSubmit: (t, info) => got.push([t, info]) })
  ed.handleInput(textKey("fix "))
  ed.handleInput({ type: "paste", text: tenLines })
  ed.handleInput(key("enter"))
  expect(got).toEqual([
    [`fix ${tenLines}`, { display: "fix [pasted 10 lines #1]", parts: ["fix ", { paste: tenLines }] }],
  ])
  expect(ed.isEmpty).toBe(true)
})

test("setParts restores folded pastes, e.g. from the prompt history", () => {
  const ed = new Editor({ foldPastes: fold })
  ed.setParts(["see ", { paste: tenLines }, "\nand this"])
  expect(ed.getDisplayText()).toBe("see [pasted 10 lines #1]\nand this")
  expect(ed.getText()).toBe(`see ${tenLines}\nand this`)
  expect(ed.getParts()).toEqual(["see ", { paste: tenLines }, "\nand this"])
})

test("a placeholder wraps as one piece and is cut to the row when wider", () => {
  const ed = new Editor({ foldPastes: fold })
  ed.handleInput(textKey("abcdef"))
  ed.handleInput({ type: "paste", text: tenLines })
  expect(view(ed, 24)).toEqual(["abcdef", "[pasted 10 lines #1]|"])
  expect(view(ed, 10)).toEqual(["abcdef", "[pasted 1…", "|"])
  ed.handleInput(key("up"))
  expect(ed.cursor).toEqual({ line: 0, col: 6 })
})

test("replacing text before the caret drops placeholders it removes", () => {
  const ed = new Editor({ foldPastes: fold })
  ed.handleInput({ type: "paste", text: tenLines })
  ed.replaceBeforeCaret(2, "x")
  expect(ed.getText()).toBe("x")
  expect(ed.getParts()).toEqual(["x"])
})

test("text carrying a placeholder's character cannot pose as a folded paste", () => {
  const ed = new Editor({ foldPastes: fold })
  ed.handleInput({ type: "paste", text: tenLines })
  // U+100000 is the first placeholder's own character.
  ed.handleInput({ type: "paste", text: "x\u{100000}y" })
  expect(ed.getDisplayText()).toBe("[pasted 10 lines #1]x�y")
  expect(ed.getText()).toBe(`${tenLines}x�y`)
  // Deleting the stand-in keeps the real paste.
  ed.handleInput(key("left"))
  ed.handleInput(key("backspace"))
  expect(ed.getText()).toBe(`${tenLines}xy`)
  expect(ed.getParts()).toEqual([{ paste: tenLines }, "xy"])
  // Typed text and restored parts are escaped too.
  ed.handleInput(key("end"))
  ed.handleInput(textKey("\u{100000}"))
  ed.setParts([...ed.getParts(), "\u{100001}"])
  expect(ed.getDisplayText()).toBe("[pasted 10 lines #1]xy��")
})

test("the default label", () => {
  expect(defaultPasteLabel({ lines: 2000, chars: 50_000, n: 3 })).toBe("[pasted 2000 lines #3]")
  expect(defaultPasteLabel({ lines: 1, chars: 1200, n: 1 })).toBe("[pasted 1200 chars #1]")
})
