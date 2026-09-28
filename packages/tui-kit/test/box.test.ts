import { expect, test } from "bun:test"
import { stripAnsi } from "../src/ansi.ts"
import { CURSOR_MARKER } from "../src/component.ts"
import { Box } from "../src/components/box.ts"
import { Editor } from "../src/components/editor.ts"
import { Text } from "../src/components/text.ts"
import { LiveRenderer } from "../src/renderer.ts"
import { defaultTheme, red } from "../src/style.ts"
import { FakeTerminal } from "../src/terminal.ts"
import { visibleWidth } from "../src/width.ts"
import { plain } from "./context.ts"
import { VirtualScreen } from "./screen.ts"

function screenFor(cols: number, rows: number) {
  const term = new FakeTerminal(cols, rows)
  const screen = new VirtualScreen(cols, rows)
  const write = term.write.bind(term)
  term.write = (d: string) => {
    write(d)
    screen.write(d)
  }
  return { term, screen }
}

test("draws a rounded border across the full width around the child", () => {
  const box = new Box(new Text("hello world"))
  expect(box.render(12, plain)).toEqual(["╭──────────╮", "│ hello    │", "│ world    │", "╰──────────╯"])
})

test("pads wide characters by display width and truncates what does not fit", () => {
  const rows = new Box({ render: () => ["你好世界", "abcdefghijk"] }).render(10, plain)
  expect(rows).toEqual(["╭────────╮", "│ 你好世 │", "│ abcdef │", "╰────────╯"])
  expect(rows.every((r) => visibleWidth(r) === 10)).toBe(true)
  // A wide character that would straddle the edge is left out, not split.
  expect(new Box({ render: () => ["a你好世"] }).render(10, plain)[1]).toBe("│ a你好  │")
})

test("labels go into the border when they fit", () => {
  const box = new Box(new Text("x"), { labels: () => ({ top: "↑ 3", bottom: "↓ 12 more" }) })
  expect(box.render(16, plain)).toEqual(["╭──────── ↑ 3 ─╮", "│ x            │", "╰── ↓ 12 more ─╯"])
  // One that does not fit is left out.
  expect(box.render(14, plain)).toEqual(["╭────── ↑ 3 ─╮", "│ x          │", "╰────────────╯"])
})

test("too narrow for a border, the child is drawn bare", () => {
  const box = new Box(new Text("abc"))
  expect(box.render(7, plain)).toEqual(["abc"])
  expect(box.render(8, plain)).toEqual(["╭──────╮", "│ abc  │", "╰──────╯"])
})

test("the border takes the theme's border color, the child's styles stay inside", () => {
  const box = new Box({ render: () => [`\x1b[31mred`] })
  const [top, mid] = box.render(10, { ...plain, theme: { ...defaultTheme, border: red } })
  expect(top).toBe(red("╭────────╮"))
  expect(mid).toBe(`${red("│")} \x1b[31mred\x1b[0m    ${red("│")}`)
})

test("the caret sits inside the box, after wide characters too, and colors can be off", () => {
  const { term, screen } = screenFor(20, 6)
  const editor = new Editor({ prompt: "> " })
  editor.setText("你好 ok")
  const r = new LiveRenderer(term, new Box(editor), { color: false })
  r.render()
  expect(screen.lines.slice(0, 3)).toEqual([
    "╭──────────────────╮",
    "│ > 你好 ok        │",
    "╰──────────────────╯",
  ])
  // Border, space, prompt, two wide characters, " ok".
  expect({ x: screen.x, y: screen.y }).toEqual({ x: 2 + 2 + 4 + 3, y: 1 })
  expect(term.output).not.toContain("\x1b[90m")
  editor.setText("abcdefghijklmnop")
  r.render()
  // A full row puts the caret on the next row, still inside the border.
  expect(screen.lines.slice(0, 4)).toEqual([
    "╭──────────────────╮",
    "│ > abcdefghijklmn │",
    "│   op             │",
    "╰──────────────────╯",
  ])
  expect({ x: screen.x, y: screen.y }).toEqual({ x: 6, y: 2 })
})

test("the caret marker survives the padding", () => {
  const editor = new Editor()
  const [, row] = new Box(editor).render(10, plain)
  expect(row!.startsWith(`│ ${CURSOR_MARKER}`)).toBe(true)
  expect(stripAnsi(row!)).toBe("│        │")
})
