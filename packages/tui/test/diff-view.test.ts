import { expect, test } from "bun:test"
import { diffToolLines, type ToolLine } from "@amira/api"
import {
  defaultTheme,
  presentEmoji,
  stripAnsi,
  stripColors,
  surfaceTheme,
  visibleWidth,
} from "@amira/tui-kit"
import { MAX_DIFF_LINE_ROWS, parseUnifiedDiff, renderToolLines } from "../src/diff-view.ts"
import { wordDiff } from "../src/word-diff.ts"

const dark = { ...defaultTheme, ...surfaceTheme("dark") }
const RED = "\x1b[48;2;71;20;26m"
const GREEN = "\x1b[48;2;15;58;18m"
const RED_WORD = "\x1b[48;2;102;33;42m"
const GREEN_WORD = "\x1b[48;2;23;85;28m"
const OFF = "\x1b[49m"

const edit: ToolLine[] = diffToolLines([
  {
    oldStart: 38,
    oldLines: 3,
    newStart: 38,
    newLines: 4,
    lines: [
      " const more = lines.length > 1",
      "-const room = width - 4",
      "+const room = width - 4 - gutter",
      "+const gutter = 2",
      " return lines",
    ],
  },
])

/** The text a row shows, with the words on the stronger color in [brackets]. */
function marked(row: string): string {
  const open = row.replaceAll(RED_WORD, "«").replaceAll(GREEN_WORD, "«")
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the end of a word's color
  return stripAnsi(open.replace(/«([^\x1b]*)\x1b\[49m/g, "[$1]"))
}

test("an edit: numbers in a gutter, changed lines on their color to the edge, changed words stronger", () => {
  const rows = renderToolLines(edit, dark, 44, "  ")
  expect(rows.map((r) => stripAnsi(r).trimEnd())).toEqual([
    "  38   const more = lines.length > 1",
    "  39 - const room = width - 4",
    "  39 + const room = width - 4 - gutter",
    "  40 + const gutter = 2",
    "  41   return lines",
  ])
  // Context lines use the code surface; changed lines use their addition/removal surface.
  expect(rows[0]!.startsWith("  \x1b[48;2;25;25;25m")).toBe(true)
  expect(visibleWidth(rows[0]!)).toBe(44)
  expect(rows[1]).toContain(dark.error("- "))
  expect(rows[2]).toContain(dark.success("+ "))
  expect(rows[1]!.startsWith(`  ${RED}`)).toBe(true)
  expect(rows[2]!.startsWith(`  ${GREEN}`)).toBe(true)
  for (const r of rows.slice(1, 4)) {
    expect(r.endsWith(OFF)).toBe(true)
    expect(visibleWidth(r)).toBe(44)
  }
  // The added words of the paired line; the removed line lost none. An added line with no
  // removed one to pair with has no words marked.
  expect(marked(rows[2]!).trimEnd()).toBe("  39 + const room = width - 4 [- gutter]")
  expect(rows[1]).not.toContain(RED_WORD)
  expect(rows[3]).not.toContain(GREEN_WORD)
  // The number is muted, on the line's color.
  expect(rows[1]).toContain(`${RED}${dark.surfaceMuted!("39 ")}${dark.error("- ")}const`)
})

test("paired lines mark the words that changed on both sides", () => {
  const rows = renderToolLines(
    [
      { kind: "diff-remove", text: "return fetchUser(id, { cache: true })", lineNo: 7 },
      { kind: "diff-add", text: "return loadUser(id, { cache: false })", lineNo: 7 },
    ],
    dark,
    60,
  )
  expect(marked(rows[0]!).trimEnd()).toBe("7 - return [fetchUser](id, { cache: [true] })")
  expect(marked(rows[1]!).trimEnd()).toBe("7 + return [loadUser](id, { cache: [false] })")
})

test("the word diff: tokens in common are kept, blanks between changed words join them", () => {
  expect(wordDiff("a b c", "a x y c")).toEqual({ before: [[2, 3]], after: [[2, 5]] })
  expect(wordDiff("f(a)", "f(a, b)")).toEqual({ before: [], after: [[3, 6]] })
  expect(wordDiff("same", "same")).toEqual({ before: [], after: [] })
  // Too different: the lines say it, not the words.
  expect(wordDiff("const a = 1", "import { x } from 'y'")).toBeUndefined()
  // Too long to compare.
  expect(wordDiff("x ".repeat(300), "y ".repeat(300))).toBeUndefined()
  // Wide characters count as the code units they are.
  expect(wordDiff("看看 这个 测试", "看看 那个 测试")).toEqual({ before: [[3, 5]], after: [[3, 5]] })
})

test("long lines wrap at narrow widths, the gutter and the background continued", () => {
  const lines: ToolLine[] = [
    { kind: "diff-remove", text: "const message = `测试 {name} 失败了`", lineNo: 120 },
    { kind: "diff-add", text: "const message = `测试 {name} 通过了` // 🧪 checked", lineNo: 120 },
  ]
  for (const width of [27, 28, 34, 40]) {
    const rows = renderToolLines(lines, dark, width, "  ")
    for (const r of rows) expect({ r, w: visibleWidth(r) }).toEqual({ r, w: width })
    const text = rows.map((r) => stripAnsi(r))
    expect(text[0]!.startsWith("  120 - ")).toBe(true)
    // Continued rows keep the gutter blank, the text lined up after the sign.
    for (const r of text.slice(1)) if (!r.startsWith("  120 ")) expect(r.startsWith("        ")).toBe(true)
    // Nothing is lost: the rows put together are the lines (no line reaches the row cap here).
    const body = text.map((r) => r.slice(8).trimEnd()).join("")
    expect(body.replace(/\s/g, "")).toContain("通过了`//🧪checked")
  }
})

test("at any width, no row is wider than the screen", () => {
  const lines: ToolLine[] = [
    ...edit,
    { kind: "diff-add", text: "测试🧪测试🧪测试🧪测试🧪", lineNo: 99 },
    { kind: "muted", text: "… 12 more lines" },
  ]
  for (let width = 1; width <= 30; width++) {
    for (const theme of [dark, defaultTheme])
      for (const r of renderToolLines(lines, theme, width, "  "))
        expect({ width, r, fits: visibleWidth(r) <= width }).toEqual({ width, r, fits: true })
  }
})

test("text-default emoji take two cells in diff rows, as the terminal draws them", () => {
  const lines: ToolLine[] = [
    { kind: "diff-remove", text: "notify(✉, ⚠) ✉✉✉✉✉✉", lineNo: 7 },
    { kind: "diff-add", text: "notify(✉, ❤) ✉✉✉✉✉✉", lineNo: 7 },
  ]
  for (let width = 10; width <= 30; width++)
    for (const r of renderToolLines(lines, dark, width, "  ")) {
      // presentEmoji is what the renderers apply; with it the terminal's width is the measured one.
      expect({ width, r, w: visibleWidth(r) }).toEqual({ width, r, w: width })
      expect({ width, r, w: Bun.stringWidth(presentEmoji(r)) }).toEqual({ width, r, w: width })
    }
})

test("a very long line wraps to a few rows and says it goes on", () => {
  const rows = renderToolLines([{ kind: "diff-add", text: "x".repeat(500), lineNo: 1 }], dark, 20)
  expect(rows).toHaveLength(MAX_DIFF_LINE_ROWS)
  expect(stripAnsi(rows.at(-1)!).trimEnd().endsWith("x…")).toBe(true)
  for (const r of rows) expect(visibleWidth(r)).toBe(20)
})

test("without the surface colors or without colors, the signs still tell the lines apart", () => {
  const plainRows = renderToolLines(edit, defaultTheme, 44)
  expect(plainRows.join("")).not.toContain("\x1b[48;")
  expect(plainRows[1]).toBe(`${defaultTheme.muted("39 ")}${defaultTheme.error("- const room = width - 4")}`)
  // NO_COLOR strips the colors on the way out: what is left reads as a diff.
  expect(renderToolLines(edit, dark, 44).map((r) => stripColors(r).trimEnd())).toEqual([
    "38   const more = lines.length > 1",
    "39 - const room = width - 4",
    "39 + const room = width - 4 - gutter",
    "40 + const gutter = 2",
    "41   return lines",
  ])
})

test("a unified diff: content lines like headers stay in their hunk, a header's context stays", () => {
  const lines = parseUnifiedDiff(
    [
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,3 +1,3 @@ select",
      " a",
      "--- old rule",
      "+++ new",
      " b",
      "@@ -10 +10 @@",
      "-x",
      "+y",
    ].join("\n"),
  )
  expect(lines.map((l) => [l.kind, l.text, l.lineNo])).toEqual([
    ["muted", "--- a/q.sql", undefined],
    ["muted", "+++ b/q.sql", undefined],
    ["diff-hunk", "⋯ select", undefined],
    ["diff-context", "a", 1],
    ["diff-remove", "-- old rule", 2],
    ["diff-add", "++ new", 2],
    ["diff-context", "b", 3],
    ["diff-hunk", "⋯", undefined],
    ["diff-remove", "x", 10],
    ["diff-add", "y", 10],
  ])
  expect(stripAnsi(renderToolLines(lines, defaultTheme, 40)[2]!)).toBe(" ⋯   select")
})

test("with an unknown background, dark surfaces and secondary line numbers are used", () => {
  const rows = renderToolLines(edit, { ...defaultTheme, ...surfaceTheme(undefined) }, 44)
  expect(rows[1]!.startsWith(`${RED}${dark.surfaceMuted!("39 ")}${dark.error("- ")}const`)).toBe(true)
})

test("a light terminal gets light backgrounds", () => {
  const rows = renderToolLines(edit, { ...defaultTheme, ...surfaceTheme("light") }, 44)
  expect(rows[1]!.startsWith("\x1b[48;2;246;213;216m")).toBe(true)
  expect(rows[2]!.startsWith("\x1b[48;2;214;240;207m")).toBe(true)
  expect(rows[2]).toContain("\x1b[48;2;188;229;177m")
})
