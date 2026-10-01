import { expect, test } from "bun:test"
import { Editor, type EditorImage, imageLabel, type SubmitInfo } from "../src/components/editor.ts"
import { key } from "../src/keys.ts"
import { plain } from "./context.ts"

const image: EditorImage = {
  name: "photo.png",
  mimeType: "image/png",
  data: Buffer.alloc(120 * 1024).toString("base64"),
}

test("image placeholders keep the payload apart from text and round-trip as parts", () => {
  const ed = new Editor()
  ed.insert("see ")
  ed.insertImage(image)
  ed.insert(" please")
  expect(ed.getText()).toBe("see  please")
  expect(ed.getDisplayText()).toBe("see [image 1: photo.png 120 KB] please")
  expect(ed.getParts()).toEqual(["see ", { image }, " please"])
  expect(ed.render(80, plain).join("\n")).toContain("[image 1: photo.png 120 KB]")
  const again = new Editor()
  again.setParts(ed.getParts())
  expect(again.getParts()).toEqual(ed.getParts())
  expect(again.getDisplayText()).toBe(ed.getDisplayText())
})

test("caret movement, backspace, Delete, undo and redo treat images as one unit", () => {
  const ed = new Editor()
  ed.insertImage(image)
  expect(ed.isEmpty).toBe(false)
  ed.handleInput(key("backspace"))
  expect(ed.isEmpty).toBe(true)
  ed.undo()
  expect(ed.getParts()).toEqual([{ image }])
  ed.redo()
  expect(ed.isEmpty).toBe(true)
  ed.undo()
  ed.handleInput(key("left"))
  expect(ed.cursor.col).toBe(0)
  ed.handleInput(key("delete"))
  expect(ed.getParts()).toEqual([])
  ed.undo()
  expect(ed.getParts()).toEqual([{ image }])
})

test("undoing image insertion forgets its payload; cut and yank restore images", () => {
  const ed = new Editor()
  ed.insertImage(image)
  ed.undo()
  expect(ed.getParts()).toEqual([])
  ed.redo()
  ed.killToLineStart()
  expect(ed.isEmpty).toBe(true)
  ed.yank()
  expect(ed.getParts()).toEqual([{ image }])
  ed.undo()
  expect(ed.isEmpty).toBe(true)
  ed.undo()
  expect(ed.getParts()).toEqual([{ image }])
})

test("image-only submit includes display and data and resets numbering", () => {
  let sent: SubmitInfo | undefined
  const ed = new Editor({
    onSubmit: (text, info) => {
      expect(text).toBe("")
      sent = info
    },
  })
  ed.insertImage(image)
  ed.insertImage({ ...image, name: "two.png" })
  expect(ed.getDisplayText()).toContain("[image 2: two.png 120 KB]")
  ed.handleInput(key("enter"))
  expect(sent?.parts).toEqual([{ image }, { image: { ...image, name: "two.png" } }])
  expect(sent?.display).toContain("[image 1:")
  expect(ed.isEmpty).toBe(true)
  ed.insertImage(image)
  expect(ed.getDisplayText()).toBe("[image 1: photo.png 120 KB]")
})

test("image labels use decoded byte counts and sanitize terminal controls", () => {
  expect(imageLabel({ ...image, data: "YQ==", name: "a\x1b\n.png" }, 1)).toBe("[image 1: a  .png 1 B]")
  const ed = new Editor()
  ed.insertImage(image)
  expect(ed.render(12, plain)).toHaveLength(2)
  expect(ed.getParts()).toEqual([{ image }])
})
