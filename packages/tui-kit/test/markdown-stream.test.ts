import { expect, test } from "bun:test"
import { stripAnsi } from "../src/ansi.ts"
import type { RenderContext } from "../src/component.ts"
import { MarkdownStream } from "../src/components/markdown-stream.ts"
import { defaultGlyphs } from "../src/glyphs.ts"
import { commitOpenBlocks, type Env, newState, step } from "../src/markdown/blocks.ts"
import { markdownStyles } from "../src/markdown/inline.ts"
import { defaultTheme } from "../src/style.ts"
import { visibleWidth } from "../src/width.ts"
import { plain } from "./context.ts"

/** A render context whose commits are collected, like the renderer's during a frame. */
function committing(): { ctx: RenderContext; committed: string[] } {
  const committed: string[] = []
  return { ctx: { ...plain, commit: (lines) => committed.push(...lines) }, committed }
}

/** Deterministic pseudo-random numbers, so a failing case can be replayed. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
}

/** Renders a whole text at once, as plain text. */
function md(text: string, width = 40, opts: { hyperlinks?: boolean } = {}): string[] {
  const m = new MarkdownStream({ hyperlinks: opts.hyperlinks ?? false })
  m.append(text)
  m.render(width, plain)
  return m.take(width).map(stripAnsi)
}

test("paragraphs keep their line breaks and wrap; inline spans lose their delimiters", () => {
  expect(md("Some **bold**, *italic*, ~~gone~~ and `a * b` here.\nNext line", 20)).toEqual([
    "Some bold, italic,",
    "gone and a * b here.",
    "Next line",
  ])
  expect(md("snake_case_name and 2 * 3 * 4 and \\*not\\* and **unclosed")).toEqual([
    "snake_case_name and 2 * 3 * 4 and *not*",
    "and **unclosed",
  ])
  expect(md("***both*** and `` a`b ``")).toEqual(["both and a`b"])
})

test("blank lines separate blocks, collapsed to one; leading and trailing ones are dropped", () => {
  expect(md("\n\n  \none\n\n\n\ntwo\n\n\n")).toEqual(["one", "", "two"])
})

test("headings, setext headings and rules", () => {
  expect(md("# One\n## Two ##\n#### Four\nText\n===\nMore\n---\n\n***")).toEqual([
    "One",
    "Two",
    "Four",
    "Text",
    "More",
    "",
    "─".repeat(40),
  ])
  const m = new MarkdownStream()
  m.append("# Title")
  expect(m.render(20, { ...plain, theme: defaultTheme })[0]).toBe(defaultTheme.heading!("Title"))
  expect(md("#hashtag")).toEqual(["#hashtag"])
})

test("lists hang their wrapped rows under the text, nest, number and check", () => {
  expect(
    md("- one two three four\n  - nested item here\n    more of it\n- [ ] open\n- [x] done\n10. ten", 14),
  ).toEqual([
    "• one two",
    "  three four",
    "  ◦ nested",
    "    item here",
    "    more of it",
    "• ☐ open",
    "• ☑ done",
    "10. ten",
  ])
  // A line right after an item continues it; after a blank line it must be indented to.
  expect(md("- item\nlazy\n\nafter")).toEqual(["• item", "  lazy", "", "after"])
  expect(md("1. a\n\n   still a\n2. b")).toEqual(["1. a", "", "   still a", "2. b"])
})

test("blockquotes get a bar per level", () => {
  expect(md("> quoted words here\n> > deeper", 12)).toEqual(["▎ quoted", "▎ words here", "▎ ▎ deeper"])
})

test("code blocks get a frame and a label; their lines hard-wrap and keep their spaces", () => {
  expect(md("```ts\nconst x = 1\n\n  if (x) {}\nabcdefghijklmnopqrst\n```\nafter", 16)).toEqual([
    "╭─ ts",
    "│ const x = 1",
    "│",
    "│   if (x) {}",
    "│ abcdefghijklmn",
    "│ opqrst",
    "╰─",
    "after",
  ])
  // Markdown inside is shown as it is; an unclosed block is closed at the end.
  expect(md("~~~\n**not bold**\n# no heading")).toEqual(["╭─", "│ **not bold**", "│ # no heading", "╰─"])
})

test("code blocks in list items are indented with the item", () => {
  expect(md("- item\n  ```\n  code\n  ```\n- next")).toEqual(["• item", "  ╭─", "  │ code", "  ╰─", "• next"])
})

test("keywords, strings, numbers and comments are highlighted in known languages", () => {
  const m = new MarkdownStream()
  m.append("```py\ndef f(): return 'x' # note\n```\n")
  const rows = m.render(40, { ...plain, theme: defaultTheme })
  const t = defaultTheme
  expect(rows[1]).toBe(
    `${t.codeFrame!("│")} ${t.keyword!("def")} f(): ${t.keyword!("return")} ${t.string!("'x'")} ${t.comment!("# note")}`,
  )
  const unknown = new MarkdownStream()
  unknown.append("```brainfuck\nif return\n```\n")
  expect(unknown.render(40, { ...plain, theme: defaultTheme })[1]).toBe(`${t.codeFrame!("│")} if return`)
})

test("tables are aligned by column, and shown raw when wider than the screen", () => {
  const table = "| Name | Qty | Note |\n|:--|--:|:-:|\n| apple | 3 | `x` |\n| kiwi | 12 | ok |"
  expect(md(table)).toEqual([
    "Name  │ Qty │ Note",
    "──────┼─────┼─────",
    "apple │   3 │  x",
    "kiwi  │  12 │  ok",
  ])
  expect(md(table, 16)).toEqual([
    "| Name | Qty |",
    "Note |",
    "|:--|--:|:-:|",
    "| apple | 3 | x",
    "|",
    "| kiwi | 12 | ok",
    "|",
  ])
  // Wider than the screen, the widest column wraps its cells when the others can stay readable.
  expect(
    md("| Lang | Use |\n|--|--|\n| Go | cloud services and networked tools |\n| C | kernels |", 24),
  ).toEqual([
    "Lang │ Use",
    `${"─".repeat(5)}┼${"─".repeat(18)}`,
    "Go   │ cloud services",
    "     │ and networked",
    "     │ tools",
    "C    │ kernels",
  ])
  // Without a delimiter row it is a paragraph.
  expect(md("a | b\nc | d")).toEqual(["a | b", "c | d"])
})

test("links are clickable with OSC 8 when supported, and show their URL otherwise", () => {
  expect(md("see [docs](https://a.dev/x) or <https://b.dev>, https://c.dev.")).toEqual([
    "see docs (https://a.dev/x) or",
    "https://b.dev, https://c.dev.",
  ])
  const m = new MarkdownStream({ hyperlinks: true })
  m.append("[docs](https://a.dev/x)")
  const row = m.render(40, plain)[0]!
  expect(row).toBe("\x1b]8;;https://a.dev/x\x07docs\x1b]8;;\x07")
  expect(visibleWidth(row)).toBe(4)
})

test("a closed block is committed at once; the open one stays live", () => {
  const { ctx, committed } = committing()
  const m = new MarkdownStream()
  m.append("# Head\n\nfirst para")
  expect(m.render(40, ctx)).toEqual(["", "first para"])
  expect(committed).toEqual(["Head"])
  // A paragraph line waits one line, since the next could make it a heading.
  m.append("\nsecond")
  m.render(40, ctx)
  expect(committed).toEqual(["Head"])
  m.append("\n")
  expect(m.render(40, ctx)).toEqual(["second"])
  expect(committed).toEqual(["Head", "", "first para"])
  expect(m.committedRows).toBe(3)
  expect(m.take(40)).toEqual(["second"])
  expect(m.committedRows).toBe(0)
})

test("rows finished while nothing could commit them are committed by the first frame that can", () => {
  const m = new MarkdownStream()
  m.append("# Head\n\nbody")
  expect(m.render(40, plain)).toEqual(["Head", "", "body"])
  const { ctx, committed } = committing()
  expect(m.render(40, ctx)).toEqual(["", "body"])
  expect(committed).toEqual(["Head"])
  m.render(40, ctx)
  expect(committed).toEqual(["Head"])
})

test("each finished line of a code block is committed as soon as it ends", () => {
  const { ctx, committed } = committing()
  const m = new MarkdownStream({ highlight: false })
  m.append("```\nline 1\nline")
  expect(m.render(40, ctx)).toEqual(["│ line"])
  expect(committed).toEqual(["╭─", "│ line 1"])
  m.append(" 2\n")
  expect(m.render(40, ctx)).toEqual([])
  expect(committed).toEqual(["╭─", "│ line 1", "│ line 2"])
  // Interrupted: the block is closed when the text is taken.
  expect(m.take(40)).toEqual(["╰─"])
})

test("a table is laid out once complete; while open it re-renders live", () => {
  const { ctx, committed } = committing()
  const m = new MarkdownStream()
  m.append("| a | b |\n|---|---|\n| 1 | 2 |\n")
  expect(m.render(40, ctx)).toEqual(["a │ b", "──┼──", "1 │ 2"])
  m.append("| wide cell | 3 |\n")
  expect(m.render(40, ctx)).toEqual(["a         │ b", "──────────┼──", "1         │ 2", "wide cell │ 3"])
  expect(committed).toEqual([])
  m.append("\nafter")
  m.render(40, ctx)
  expect(committed).toEqual(["a         │ b", "──────────┼──", "1         │ 2", "wide cell │ 3"])
})

test("a table taller than the live region is committed with the widths it has so far", () => {
  const { ctx, committed } = committing()
  const m = new MarkdownStream()
  m.maxRows = 3
  m.append("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n")
  m.render(40, ctx)
  // The columns get some room to spare for the rows still to come.
  expect(committed).toEqual(["a     │ b", "──────┼──────", "1     │ 2", "3     │ 4"])
  m.append("| wider | 5 |\n| wider still | 6 |\n")
  m.render(40, ctx)
  // A cell wider than its column wraps within it.
  expect(committed.slice(4)).toEqual(["wider │ 5", "wider │ 6", "still │"])
})

test("a frozen table keeps no rows: the work per row stays the same however long it gets", () => {
  const env: Env = {
    width: 40,
    styles: markdownStyles(defaultTheme),
    glyphs: defaultGlyphs,
    hyperlinks: false,
    highlight: false,
  }
  const out: string[] = []
  const sink = (rows: string[]) => out.push(...rows)
  const s = newState()
  for (const line of ["| a | b |", "|---|---|", "| 1 | 2 |"]) step(s, line, env, sink)
  commitOpenBlocks(s, env, sink)
  for (let i = 0; i < 50; i++) step(s, `| ${i} | x |`, env, sink)
  expect(s.table!.rows).toEqual([])
  expect(s.table!.lines).toEqual([])
  expect(out.length).toBe(3 + 50)
})

test("a line longer than the live region commits its finished rows, carrying open spans over", () => {
  const { ctx, committed } = committing()
  const m = new MarkdownStream()
  m.maxRows = 2
  m.append("- **one two three four five six")
  // The bold span is not closed yet, so it shows its delimiters.
  expect(m.render(10, ctx)).toEqual(["  five six"])
  expect(committed).toEqual(["• **one", "  two", "  three", "  four"])
  const { ctx: ctx2, committed: c2 } = committing()
  const t = new MarkdownStream()
  t.maxRows = 2
  t.append("- **one two three four five** six")
  t.render(10, { ...ctx2, theme: defaultTheme })
  expect(c2.map(stripAnsi)).toEqual(["• one two", "  three", "  four"])
  // The rest is still bold: the delimiters were carried over.
  expect(t.render(10, { ...ctx2, theme: defaultTheme })[0]).toBe(`  ${defaultTheme.strong!("five")} six`)
  expect(t.take(10).map(stripAnsi)).toEqual(["  five six"])
})

// Streaming properties

const LINES = [
  "# Heading **bold**",
  "## Second",
  "Setext",
  "===",
  "---",
  "",
  "",
  "plain words in a paragraph that is long enough to wrap around",
  "more **bold text** and *italic* and `code span` here",
  "a [link](http://x.y/z) and https://q.r/s done",
  "你好世界，这是一个很长的中文句子",
  "tab\there",
  "- item one with words",
  "- item **two**",
  "  - nested item",
  "  continuation",
  "1. first",
  "2. second",
  "- [x] task",
  "> quoted *line* here",
  "> > nested quote",
  "```ts",
  "```averyveryverylonglanguagename",
  "const x = 'y' // comment",
  "  indented code line that is long",
  "```",
  "~~~",
  "| h1 | h2 |",
  "|----|:--:|",
  "| cell | **b** |",
  "| another cell here | x |",
  "supercalifragilisticexpialidocious",
  "\\*escaped\\*",
]

function randomDoc(rand: () => number, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(LINES[Math.floor(rand() * LINES.length)]!)
  return out.join("\n")
}

/** Streams `text` in random chunks, rendering after each, and returns committed plus final rows. */
function stream(
  text: string,
  rand: () => number,
  widthOf: () => number,
  maxRowsOf: () => number,
): { rows: string[]; lives: string[][]; widths: number[] } {
  const { ctx, committed } = committing()
  const m = new MarkdownStream({ hyperlinks: false })
  const points = Array.from(text)
  const lives: string[][] = []
  const widths: number[] = []
  let at = 0
  let width = widthOf()
  while (at < points.length) {
    const n = 1 + Math.floor(rand() * 9)
    m.append(points.slice(at, at + n).join(""))
    at += n
    m.maxRows = maxRowsOf()
    width = widthOf()
    lives.push(m.render(width, ctx))
    widths.push(width)
  }
  return { rows: [...committed, ...m.take(width)], lives, widths }
}

/** The letters and digits shown, but not the code blocks' labels, which are cut to the width. */
const letters = (rows: string[]) =>
  rows
    .map(stripAnsi)
    .filter((r) => !r.trimStart().startsWith("╭─"))
    .join("")
    .replace(/[^\p{L}\p{N}]/gu, "")

test("streamed in any chunks, the rows are those of the whole text at once", () => {
  for (let seed = 1; seed <= 150; seed++) {
    const rand = rng(seed)
    const text = randomDoc(rand, 25)
    const width = 8 + Math.floor(rand() * 40)
    const whole = md(text, width)
    const { rows } = stream(
      text,
      rand,
      () => width,
      () => 1000,
    )
    expect({ seed, rows: rows.map(stripAnsi) }).toEqual({ seed, rows: whole })
  }
})

test("with a small live region nothing is lost or repeated, and rows fit the width", () => {
  for (let seed = 1; seed <= 150; seed++) {
    const rand = rng(seed * 7)
    const text = randomDoc(rand, 25)
    const width = 6 + Math.floor(rand() * 30)
    const { rows, lives } = stream(
      text,
      rand,
      () => width,
      () => 1 + Math.floor(rand() * 5),
    )
    expect({ seed, text: letters(rows) }).toEqual({ seed, text: letters(md(text, width)) })
    for (const r of [...rows, ...lives.flat()])
      expect({ seed, r, w: visibleWidth(r) <= width }).toEqual({ seed, r, w: true })
  }
})

test("a width change mid-stream re-wraps only the live block and loses nothing", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rand = rng(seed * 13)
    const text = randomDoc(rand, 25)
    const { rows, lives, widths } = stream(
      text,
      rand,
      () => 5 + Math.floor(rand() * 40),
      () => 1 + Math.floor(rand() * 8),
    )
    expect({ seed, text: letters(rows) }).toEqual({ seed, text: letters(md(text, 80)) })
    lives.forEach((live, i) => {
      for (const r of live) expect(visibleWidth(r)).toBeLessThanOrEqual(widths[i]!)
    })
  }
})

test("a prose line longer than the live region keeps it within maxRows", () => {
  const { ctx } = committing()
  const m = new MarkdownStream()
  const words = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ")
  for (let at = 0; at < words.length; at += 7) {
    m.append(words.slice(at, at + 7))
    m.maxRows = 3
    expect(m.render(20, ctx).length).toBeLessThanOrEqual(3)
  }
})

test("per-frame work stays bounded by the open block", () => {
  const { ctx } = committing()
  const m = new MarkdownStream()
  const text = randomDoc(rng(3), 4000)
  const start = performance.now()
  for (let at = 0; at < text.length; at += 40) {
    m.append(text.slice(at, at + 40))
    m.maxRows = 10
    m.render(80, ctx)
  }
  m.take(80)
  expect(performance.now() - start).toBeLessThan(5000)
})
