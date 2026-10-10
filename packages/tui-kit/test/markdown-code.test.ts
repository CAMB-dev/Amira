import { expect, test } from "bun:test"
import { RESET, stripAnsi } from "../src/ansi.ts"
import { MarkdownStream, renderMarkdown } from "../src/components/markdown-stream.ts"
import { defaultGlyphs, type Glyphs } from "../src/glyphs.ts"
import { bg256 } from "../src/style.ts"
import { visibleWidth } from "../src/width.ts"
import { plain } from "./context.ts"

const background = bg256(234)
const theme = {
  ...plain.theme,
  codeBg: background,
  keyword: (text: string) => `\x1b[31m${text}${RESET}`,
}
const context = { ...plain, theme, color: true }
const ascii: Glyphs = {
  ...defaultGlyphs,
  codeTop: "+-",
  codeBottom: "+-",
  codeSide: "|",
  boxTopRight: "+",
  boxBottomRight: "+",
  rule: "-",
}

/** Display columns with the code surface active, including spaces and syntax resets. */
function painted(row: string): boolean[] {
  let on = false
  const cells: boolean[] = []
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences
  for (const part of row.split(/(\x1b\[[\d;]*m)/)) {
    if (part.startsWith("\x1b[")) {
      const sgr = part.slice(2, -1)
      if (sgr === "0" || sgr === "49") on = false
      else if (sgr.startsWith("48;")) on = true
    } else cells.push(...Array.from({ length: visibleWidth(part) }, () => on))
  }
  return cells
}

function surface(rows: string[], width: number, indent = 0) {
  for (const row of rows) {
    expect(visibleWidth(row)).toBe(width)
    expect(painted(row)).toEqual(Array.from({ length: width }, (_, col) => col >= indent))
  }
}

test("code surfaces close at full width, including label, blank rows and syntax resets", () => {
  const rows = renderMarkdown("```ts\nconst x = 1\n\nabcdefghijklmnopqrst\n```", 16, theme)
  expect(rows.map(stripAnsi)).toEqual([
    "╭─ ts──────────╮",
    "│ const x = 1  │",
    `│${" ".repeat(14)}│`,
    "│ abcdefghijklm│",
    "│ nopqrst      │",
    `╰${"─".repeat(14)}╯`,
  ])
  surface(rows, 16)
})

test("list code surfaces leave the list indent unpainted on every row", () => {
  const rows = renderMarkdown("- item\n  ```ts\n  const x = 1\n\n  界界界\n  ```", 12, theme)
  expect(rows.map(stripAnsi)).toEqual([
    "• item",
    "  ╭─ ts────╮",
    "  │ const x│",
    "  │  = 1   │",
    "  │        │",
    "  │ 界界界 │",
    "  ╰────────╯",
  ])
  surface(rows.slice(1), 12, 2)
  for (const width of [3, 4, 5, 6, 7]) {
    const narrow = renderMarkdown("- x\n  ```\n  界a\n\n  ```", width, theme)
    const inset = Math.min(2, width - 2)
    const room = width - inset
    surface(narrow.slice(1), width, inset)
    const bodies = room === 2 ? ["界", "a"] : ["界a"]
    expect(narrow.slice(2, -1).map(stripAnsi)).toEqual([
      ...bodies.map((body) => " ".repeat(inset) + body + " ".repeat(room - visibleWidth(body))),
      " ".repeat(width),
    ])
  }
})

test("code frames do not reserve the first-row timestamp budget", () => {
  const rows = renderMarkdown("```a-language-that-is-too-long\nx\n```", 12, theme, {
    firstRowWidth: 3,
  })
  expect(rows.map(stripAnsi)).toEqual(["╭─ a-langu…╮", "│ x        │", "╰──────────╯"])
  surface(rows, 12)
})

test("streamed live, partial committed and final code rows use the same closed surface", () => {
  const source = "```ts\nconst value = '界界界abcdefghijk'\n\n```\n"
  const stream = new MarkdownStream({ hyperlinks: false })
  stream.maxRows = 1
  const committed: string[] = []
  const ctx = { ...context, commit: (rows: string[]) => committed.push(...rows) }
  for (const char of source) {
    stream.append(char)
    const live = stream.render(10, ctx)
    const code = live.filter((row) => stripAnsi(row).startsWith("│") || stripAnsi(row).startsWith("╭─"))
    surface(code, 10)
  }
  const rows = [...committed, ...stream.take(10)]
  expect(rows).toEqual(renderMarkdown(source, 10, theme, { hyperlinks: false }))
  surface(rows, 10)
})

test("claimed code has the same surface live, committed, and in declined fallback", () => {
  const nodes = {
    claimsCode: () => true,
    render: (_node: unknown, fallback: string[]) => fallback,
  }
  const stream = new MarkdownStream({ nodes })
  const committed: string[] = []
  const ctx = { ...context, commit: (rows: string[]) => committed.push(...rows) }
  stream.append("```diagram\n界界abcdef\n\n")
  surface(stream.render(9, ctx), 9)
  expect(committed).toEqual([])
  stream.append("```\n")
  expect(stream.render(9, ctx)).toEqual([])
  surface(committed, 9)
  expect(committed).toEqual(renderMarkdown("```diagram\n界界abcdef\n\n```", 9, theme, { nodes }))
})

test("ASCII code fallback keeps wide characters and text instead of spending narrow rows on gutters", () => {
  const rows = renderMarkdown("```language\n界界a\n\n```", 5, theme, { glyphs: ascii })
  expect(rows.map(stripAnsi)).toEqual(["lang…", "界界a", "     ", "     "])
  surface(rows, 5)
  for (const width of [1, 2, 3, 4]) {
    const narrow = renderMarkdown("```long\n界ab\n\n```", width, theme, { glyphs: ascii })
    surface(narrow, width)
    expect(narrow.slice(1, -1).map(stripAnsi).join("").replace(/ /g, "")).toBe(width === 1 ? "…ab" : "界ab")
  }
  expect(renderMarkdown("```\n界a\n```", 4, theme, { glyphs: ascii }).map(stripAnsi)).toEqual([
    "    ",
    "界a ",
    "    ",
  ])
})

for (const [width, indent, body, expected] of [
  [5, 2, "界abcdef", ["  界a", "  bcd", "  ef "]],
  [7, 2, "界界abcdef", ["  界界a", "  bcdef"]],
  [5, 0, "界abcdef", ["界abc", "def  "]],
] as const) {
  test(`unframed narrow code at ${width} cells with ${indent} inset preserves text`, () => {
    const lead = " ".repeat(indent)
    const source = `${indent ? "- x\n" : ""}${lead}\`\`\`ts\n${lead}${body}\n${lead}\`\`\``
    const rows = renderMarkdown(source, width, theme)
    const code = rows.slice(indent ? 2 : 1, -1)
    expect(code.map(stripAnsi)).toEqual([...expected])
    surface(code, width, indent)
    const stream = new MarkdownStream()
    stream.maxRows = 1
    const committed: string[] = []
    for (const char of source) {
      stream.append(char)
      stream.render(width, { ...context, commit: (lines) => committed.push(...lines) })
    }
    expect([...committed, ...stream.take(width)]).toEqual(rows)
  })
}
