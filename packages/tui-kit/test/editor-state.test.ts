import { expect, test } from "bun:test"
import { Editor, type EditorPart } from "../src/components/editor.ts"
import { restoreEditorState } from "../src/internal/editor-state.ts"
import { plain } from "./context.ts"

const image = { name: "private.png", mimeType: "image/png", data: "YQ==" }
const privateParts: EditorPart[] = ["private ", { paste: "private\npaste" }, { image }]

for (const source of ["undo", "redo", "kill"] as const) {
  test(`focus-boundary restoration drops ${source} text, paste and image snapshots`, () => {
    const editor = new Editor()
    editor.setParts(privateParts)
    if (source === "redo") editor.undo()
    if (source === "kill") editor.killToLineStart()
    restoreEditorState(editor, ["destination"])
    expect(editor.getParts()).toEqual(["destination"])
    expect(editor.undo()).toBe(false)
    expect(editor.redo()).toBe(false)
    expect(editor.yank()).toBe(true)
    expect(editor.getParts()).toEqual(["destination"])
    // First editing operation in the destination starts a new undo group.
    editor.insert("x")
    expect(editor.undo()).toBe(true)
    expect(editor.getParts()).toEqual(["destination"])
    expect(editor.undo()).toBe(false)
    expect(editor.redo()).toBe(true)
    expect(editor.getParts()).toEqual(["destinationx"])
  })
}

test("restoration retains only destination attachments and silently updates the placeholder", () => {
  const changes: string[] = []
  const editor = new Editor({ placeholder: "Message Amira", onChange: (text) => changes.push(text) })
  editor.setParts(privateParts)
  restoreEditorState(editor, [
    { paste: "destination\npaste" },
    { image: { ...image, name: "destination.png" } },
  ])
  expect(editor.getParts()).toEqual([
    { paste: "destination\npaste" },
    { image: { ...image, name: "destination.png" } },
  ])
  expect(editor.getDisplayText()).toBe("[pasted 2 lines #1][image 1: destination.png 1 B]")
  expect(editor.undo()).toBe(false)
  expect(editor.redo()).toBe(false)
  restoreEditorState(editor, [], "Message Design")
  expect(editor.render(80, plain).join("\n")).toContain("Message Design")
  restoreEditorState(editor, [])
  expect(editor.render(80, plain).join("\n")).toContain("Message Amira")
  expect(changes).toEqual([])
})

test("ordinary setParts keeps its public undo behavior, including attachment snapshots", () => {
  const editor = new Editor()
  editor.setParts(privateParts)
  editor.killToLineStart()
  editor.setParts(["replacement"])
  expect(editor.undo()).toBe(true)
  expect(editor.getParts()).toEqual([])
  expect(editor.undo()).toBe(true)
  expect(editor.getParts()).toEqual(privateParts)
  expect(editor.redo()).toBe(true)
  expect(editor.getParts()).toEqual([])
  editor.yank()
  expect(editor.getParts()).toEqual(privateParts)
})

test("editor reset closures are isolated per instance", () => {
  const first = new Editor()
  const second = new Editor()
  first.setParts(privateParts)
  second.insert("second")
  restoreEditorState(first, ["first"])
  expect(first.undo()).toBe(false)
  expect(second.undo()).toBe(true)
  expect(second.getParts()).toEqual([])
  expect(first.getParts()).toEqual(["first"])
})
