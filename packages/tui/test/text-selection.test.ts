import { expect, test } from "bun:test"
import { ImageLoader, stripAnsi } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { Block, type BlockEnv, type BlockImages, LinesBlock, ReplyBlock } from "../src/blocks.ts"
import { cellsOf, chromeRows, markCells, sliceCells, wordAt } from "../src/text-selection.ts"
import type { BlockKind } from "../src/transcript.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"

const env = (width = 60): BlockEnv => ({
  theme: plain.theme,
  width,
  now: 0,
  spinner: "*",
  detail: "summary",
  presenters: undefined,
  hyperlinks: false,
  nodes: new Map(),
})

/** A block whose lines can be changed, as a tool call's change when it finishes. */
class Lines extends Block {
  constructor(
    readonly kind: BlockKind,
    public text: string[],
  ) {
    super()
  }
  lines(): string[] {
    return this.text
  }
  copyText(): string {
    return this.text.join("\n")
  }
}

const ON = "\x1b[7m"
const OFF = "\x1b[27m"

/** The viewport row showing `text` in the last frame. */
function rowOf(rows: string[], text: string): number {
  const i = rows.findIndex((r) => stripAnsi(r).includes(text))
  if (i === -1) throw new Error(`no row shows ${JSON.stringify(text)}:\n${rows.map(stripAnsi).join("\n")}`)
  return i
}

/** The column where `text` starts in a row (plain rows here: columns are characters, but for wide ones). */
function colOf(rows: string[], text: string): number {
  const row = stripAnsi(rows[rowOf(rows, text)]!)
  return Bun.stringWidth(row.slice(0, row.indexOf(text)))
}

test("cells follow the terminal's columns: CJK and emoji take two, escapes none, tabs reach the next stop", () => {
  const line = "\x1b[31ma二😀\x1b[0m\tb"
  const cells = cellsOf(line).filter((c) => !c.escape)
  expect(cells.map((c) => [c.text, c.col, c.width])).toEqual([
    ["a", 0, 1],
    ["二", 1, 2],
    ["😀", 3, 2],
    ["\t", 5, 3],
    ["b", 8, 1],
  ])
  // A wide character is in a range when any of its cells is.
  expect(sliceCells(line, 2, 4)).toBe("二😀")
  expect(sliceCells(line, 0, Number.POSITIVE_INFINITY)).toBe("a二😀\tb")
})

test("marking keeps escape sequences and marks again after one inside the range", () => {
  const marks = { on: ON, off: OFF }
  expect(markCells("\x1b[31mab\x1b[0mcd", 1, 3, marks)).toBe(`\x1b[31ma${ON}b\x1b[0m${ON}c${OFF}d`)
  expect(markCells("ab", 0, Number.POSITIVE_INFINITY, marks)).toBe(`${ON}ab${OFF}`)
  // A wide character is marked whole.
  expect(markCells("a二b", 2, 3, marks)).toBe(`a${ON}二${OFF}b`)
})

test("a word is letters, digits and path characters, without the punctuation after it", () => {
  const line = "see src/a.ts. or 漢字です, ok"
  const word = (col: number) => {
    const r = wordAt(line, col)
    return r && sliceCells(line, r.from, r.to)
  }
  expect(word(6)).toBe("src/a.ts")
  expect(word(0)).toBe("see")
  expect(word(3)).toBe(" ")
  expect(word(Bun.stringWidth("see src/a.ts. or 漢"))).toBe("漢字です")
  expect(word(100)).toBeUndefined()
})

test("the symbols in front of tool rows are chrome; rows under them keep their own indent", () => {
  const rows = ["● read a.ts", "  └ contents of a.ts", "    line 2", "      indented", "  ├ ◆ explorer · 3s"]
  const from = chromeRows(rows).map((r) => r.from)
  expect(from).toEqual([2, 4, 4, 4, 6])
})

/** A pane with a user message, a reply with a code block and a tool call, drawn 20 rows high. */
function conversation(width = 40) {
  const pane = new TranscriptPane()
  pane.add(new LinesBlock("user", (_w, t) => [`${t.accent("›")} hello there`], "hello there"))
  const reply = [
    "Some **bold** text.",
    "",
    "```ts",
    "const long = 'a string that is far too long for the row'",
    "  indented()",
    "```",
    "",
    "After.",
  ].join("\n")
  pane.add(new ReplyBlock(reply, false, false))
  const tool = new Lines("tool", ["● read a.ts", "  └ contents of a.ts", "    line 2", "      nested"])
  pane.add(tool)
  const e = env(width)
  const rows = pane.render(e, 20)
  return { pane, rows, e, tool }
}

test("dragging across rows and blocks marks them and copies what is shown, less the chrome", () => {
  const { pane, rows, e } = conversation()
  const from = rowOf(rows, "hello")
  const to = rowOf(rows, "nested")
  pane.startDrag(from, colOf(rows, "hello"))
  expect(pane.hasText).toBe(false)
  pane.dragTo(to, colOf(rows, "nested") + "nested".length - 1)
  expect(pane.hasText).toBe(true)
  const drawn = pane.render(e, 20)
  // The rows in between are marked, the gutter of the first before the mark.
  expect(drawn[from]).toBe(`› ${ON}hello there${OFF}`)
  expect(drawn[rowOf(drawn, "After.")]).toBe(`${ON}  After.${OFF}`)
  // The last row up to the cell the drag ended on.
  expect(drawn[to]).toBe(`${ON}      nested${OFF}`)
  pane.endDrag()
  expect(pane.selectedText()).toBe(
    [
      "hello there",
      "",
      "Some bold text.",
      "",
      // The code as it is: its frame left out, the wrapped line one line again, its indent kept.
      "const long = 'a string that is far too long for the row'",
      "  indented()",
      "",
      "After.",
      "",
      "read a.ts",
      "contents of a.ts",
      "line 2",
      "  nested",
    ].join("\n"),
  )
})

test("a selection starting inside a row copies from there; one inside the chrome from its text", () => {
  const { pane, rows } = conversation()
  const at = rowOf(rows, "contents")
  pane.startDrag(at, colOf(rows, "of a.ts"))
  pane.dragTo(at + 1, 0)
  expect(pane.selectedText()).toBe("of a.ts")
  pane.startDrag(at, 0)
  pane.dragTo(at + 1, 100)
  expect(pane.selectedText()).toBe("contents of a.ts\nline 2")
})

test("CJK and emoji are selected by the cells they take", () => {
  const pane = new TranscriptPane()
  pane.add(new ReplyBlock("漢字 and 😀 here", false, false))
  const rows = pane.render(env(), 5)
  const row = rowOf(rows, "漢字")
  // From the second cell of 字 to the first of 😀.
  pane.startDrag(row, colOf(rows, "字") + 1)
  pane.dragTo(row, colOf(rows, "😀"))
  expect(pane.selectedText()).toBe("字 and 😀")
  expect(pane.render(env(), 5)[row]).toBe(`  漢${ON}字 and 😀${OFF} here`)
})

test("a double click selects a word, a triple click the line with the rows it wraps over", () => {
  const { pane, rows } = conversation(40)
  const bold = rowOf(rows, "Some bold")
  expect(pane.selectWord(bold, colOf(rows, "bold") + 1)).toBe(true)
  expect(pane.selectedText()).toBe("bold")
  const code = rowOf(rows, "const long")
  expect(pane.selectLine(code + 1, 5)).toBe(true)
  expect(pane.selectedText()).toBe("const long = 'a string that is far too long for the row'")
  // A blank row has no word; the gap between blocks no line.
  expect(pane.selectWord(bold + 1, 3)).toBe(false)
  expect(pane.selectLine(rowOf(rows, "read a.ts") - 1, 0)).toBe(false)
})

test("the selection holds while a reply streams on below it and while scrolling; a resize clears it", () => {
  const pane = new TranscriptPane()
  const reply = new ReplyBlock("first paragraph\n\nsecond", true, false)
  pane.add(reply)
  let rows = pane.render(env(), 6)
  const row = rowOf(rows, "first")
  pane.startDrag(row, 2)
  pane.dragTo(row, 100)
  pane.endDrag()
  expect(pane.selectedText()).toBe("first paragraph")
  for (let i = 0; i < 10; i++) {
    reply.append(` more ${i}\n\nline ${i}`)
    rows = pane.render(env(), 6)
  }
  expect(pane.hasText).toBe(true)
  reply.finish()
  pane.render(env(), 6)
  expect(pane.hasText).toBe(true)
  // Scrolled up to it, it is still marked.
  pane.toTop()
  rows = pane.render(env(), 6)
  expect(rows[rowOf(rows, "first")]).toBe(`  ${ON}first paragraph${OFF}`)
  expect(pane.selectedText()).toBe("first paragraph")
  pane.render(env(50), 6)
  expect(pane.hasText).toBe(false)
})

test("a change to the text it covers clears the selection; one elsewhere does not", () => {
  const { pane, rows, e, tool } = conversation()
  const at = rowOf(rows, "contents")
  pane.startDrag(at, 4)
  pane.dragTo(at, 100)
  pane.endDrag()
  // Another row of the same block changes: what is selected is the same.
  tool.text = [...tool.text.slice(0, 3), "      changed"]
  tool.touch()
  pane.render(e, 20)
  expect(pane.selectedText()).toBe("contents of a.ts")
  tool.text = ["● read a.ts", "  └ other result"]
  tool.touch()
  pane.render(e, 20)
  expect(pane.hasText).toBe(false)
})

test("a block selected with the keyboard takes the place of selected text", () => {
  const { pane, rows, e } = conversation()
  pane.selectWord(rowOf(rows, "hello"), colOf(rows, "hello"))
  expect(pane.hasText).toBe(true)
  pane.selectPrev()
  expect(pane.hasText).toBe(false)
  expect(pane.selected?.kind).toBe("tool")
  pane.render(e, 20)
  pane.selectWord(rowOf(rows, "hello"), colOf(rows, "hello"))
  expect(pane.selected).toBeUndefined()
})

/** A 30×40 PNG: 3 columns and 2 rows of 10×20 cells. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAB4AAAAoCAYAAADpE0oSAAAAaklEQVR4Xu3NkQKDUABA0XA4HA6HwzAMwzAIwjAMwzAMwzAMH4Zh2F/U/YjwwuETRWW4Xnjjgy9++CNGghQZchSoUKNBiw49BoyYMGPBioANOw6cMDY2NjY2NjYOxsbGxsbGxsbB2Pix+AZFpUoFb9YsKwAAAABJRU5ErkJggg==",
  "base64",
)

test("an image copies as its alt text, once, from any of its rows", async () => {
  const loader = new ImageLoader({
    support: { protocol: "sixel", cell: { width: 10, height: 20 } },
    cwd: ".",
    fetchRemote: async () => ({ bytes: PNG, contentType: "image/png" }),
    maxRows: () => 20,
  })
  const images: BlockImages = { loader, changed: () => {} }
  const e = { ...env(), images }
  const reply = new ReplyBlock("Before\n\n![a cat](https://img.test/c.png)\n\nAfter", false, false)
  reply.lines(e)
  const source = loader.screen("https://img.test/c.png")!
  for (let i = 0; i < 200 && source.state === "loading"; i++) await Bun.sleep(5)
  const pane = new TranscriptPane()
  pane.add(reply)
  const rows = pane.render(e, 10)
  // It takes two rows (its alt text on the first until it is drawn).
  const before = rowOf(rows, "Before")
  expect(reply.lines(e).slice(2, 4)).toEqual(["", ""])
  const alt = "🖼 a cat (https://img.test/c.png)"
  pane.startDrag(before, 0)
  pane.dragTo(rowOf(rows, "After"), 100)
  expect(pane.selectedText()).toBe(`Before\n\n${alt}\n\nAfter`)
  // From its second row on.
  pane.startDrag(before + 3, 0)
  pane.dragTo(rowOf(rows, "After"), 100)
  expect(pane.selectedText()).toBe(`${alt}\n\nAfter`)
})
