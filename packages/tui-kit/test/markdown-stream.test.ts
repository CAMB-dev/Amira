import { expect, test } from "bun:test"
import { stripAnsi } from "../src/ansi.ts"
import type { RenderContext } from "../src/component.ts"
import { MarkdownStream, renderMarkdown } from "../src/components/markdown-stream.ts"
import { defaultGlyphs } from "../src/glyphs.ts"
import { commitOpenBlocks, type Env, newState, step } from "../src/markdown/blocks.ts"
import { markdownStyles } from "../src/markdown/inline.ts"
import { defaultTheme, fg256 } from "../src/style.ts"
import { presentEmoji, visibleWidth } from "../src/width.ts"
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

// Mark only frame/label styling so the resize property can distinguish unframed labels from code.
const frameStyle = fg256(255)
const frameOpen = frameStyle("\0").split("\0")[0]!
const labelledContext = { ...plain, theme: { ...plain.theme, codeFrame: frameStyle } }

/** Renders a whole text at once; the resize property retains frame-label metadata. */
function md(text: string, width = 40, opts: { hyperlinks?: boolean; markFrames?: boolean } = {}): string[] {
  const m = new MarkdownStream({ hyperlinks: opts.hyperlinks ?? false })
  m.append(text)
  m.render(width, opts.markFrames ? labelledContext : plain)
  const rows = m.take(width)
  return opts.markFrames ? rows : rows.map(stripAnsi)
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
  // A heading is set apart from what came before it, blank line or not.
  expect(md("# One\n## Two ##\n#### Four\nText\n===\nMore\n---\n\n***")).toEqual([
    "One",
    "",
    "Two",
    "",
    "Four",
    "",
    "Text",
    "",
    "More",
    "",
    "─".repeat(40),
  ])
  expect(md("Some text\n## Next")).toEqual(["Some text", "", "Next"])
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
    "• [ ] open",
    "• [✓] done",
    "10. ten",
  ])
  // A line right after an item continues it; after a blank line it must be indented to.
  expect(md("- item\nlazy\n\nafter")).toEqual(["• item", "  lazy", "", "after"])
  expect(md("1. a\n\n   still a\n2. b")).toEqual(["1. a", "", "   still a", "2. b"])
})

test("ordered lists are numbered from their first item on, whatever numbers they were written with", () => {
  expect(md("1. a\n1. b\n1. c")).toEqual(["1. a", "2. b", "3. c"])
  expect(md("3) a\n3) b")).toEqual(["3) a", "4) b"])
  // Loose, with nested lists and continued paragraphs, it goes on.
  expect(md("1. a\n\n   more\n   1. x\n   1. y\n1. b")).toEqual([
    "1. a",
    "",
    "   more",
    "   1. x",
    "   2. y",
    "2. b",
  ])
  // A paragraph or another kind of list ends it: the next one starts again.
  expect(md("1. a\n1. b\n\ntext\n\n1. c")).toEqual(["1. a", "2. b", "", "text", "", "1. c"])
  expect(md("1. a\n- b\n1. c")).toEqual(["1. a", "• b", "1. c"])
  // A lazy continuation line does not end it.
  expect(md("1. a\nlazy\n1. b")).toEqual(["1. a", "   lazy", "2. b"])
  // Nine items and a tenth: the number grows and its text moves along.
  expect(md(`${"1. x\n".repeat(9)}1. ten`).at(-1)).toBe("10. ten")
})

test("blockquotes get a bar per level", () => {
  expect(md("> quoted words here\n> > deeper", 12)).toEqual(["▎ quoted", "▎ words here", "▎ ▎ deeper"])
})

test("code blocks get a frame and a label; their lines hard-wrap and keep their spaces", () => {
  expect(md("```ts\nconst x = 1\n\n  if (x) {}\nabcdefghijklmnopqrst\n```\nafter", 16)).toEqual([
    `╭─ ts${"─".repeat(10)}╮`,
    "│ const x = 1  │",
    `│${" ".repeat(14)}│`,
    "│   if (x) {}  │",
    "│ abcdefghijklm│",
    "│ nopqrst      │",
    `╰${"─".repeat(14)}╯`,
    "after",
  ])
  // Markdown inside is shown as it is; an unclosed block is closed at the end.
  expect(md("~~~\n**not bold**\n# no heading")).toEqual([
    `╭${"─".repeat(38)}╮`,
    `│ **not bold**${" ".repeat(25)}│`,
    `│ # no heading${" ".repeat(25)}│`,
    `╰${"─".repeat(38)}╯`,
  ])
})

test("code blocks in list items are indented with the item", () => {
  expect(md("- item\n  ```\n  code\n  ```\n- next")).toEqual([
    "• item",
    `  ╭${"─".repeat(36)}╮`,
    `  │ code${" ".repeat(31)}│`,
    `  ╰${"─".repeat(36)}╯`,
    "• next",
  ])
})

test("keywords, strings, numbers and comments are highlighted in known languages", () => {
  const m = new MarkdownStream()
  m.append("```py\ndef f(): return 'x' # note\n```\n")
  const rows = m.render(40, { ...plain, theme: defaultTheme })
  const t = defaultTheme
  expect(rows[1]).toBe(
    `${t.codeFrame!("│")} ${t.keyword!("def")} f(): ${t.keyword!("return")} ${t.string!("'x'")} ${t.comment!("# note")}${" ".repeat(37 - visibleWidth("def f(): return 'x' # note"))}${t.codeFrame!("│")}`,
  )
  const unknown = new MarkdownStream()
  unknown.append("```brainfuck\nif return\n```\n")
  expect(unknown.render(40, { ...plain, theme: defaultTheme })[1]).toBe(
    `${t.codeFrame!("│")} if return${" ".repeat(28)}${t.codeFrame!("│")}`,
  )
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

test("images show as a glyph and their alt text (or file name), linking to the image", () => {
  expect(md('![a cat](cat.png "Title") and ![](https://x.dev/img/dog%202.jpg?s=1)', 80)).toEqual([
    "🖼\uFE0F a cat (cat.png) and 🖼\uFE0F dog 2.jpg (https://x.dev/img/dog%202.jpg?s=1)",
  ])
  const m = new MarkdownStream({ hyperlinks: true })
  m.append("![a *cat*](cat.png)")
  const row = m.render(40, plain)[0]!
  expect(row).toBe("\x1b]8;;cat.png\x07🖼\uFE0F a *cat*\x1b]8;;\x07")
  // Inside a link it is that link's text; the link's URL follows it.
  expect(md("[![CI](https://ci.x/badge.svg)](https://ci.x/run)", 80)).toEqual([
    "🖼\uFE0F CI (https://ci.x/badge.svg) (https://ci.x/run)",
  ])
  const linked = new MarkdownStream({ hyperlinks: true })
  linked.append("[![CI](https://ci.x/badge.svg)](https://ci.x/run)")
  expect(linked.render(40, plain)[0]).toBe("\x1b]8;;https://ci.x/run\x07🖼\uFE0F CI\x1b]8;;\x07")
  // Not an image: an empty target, or a lone `!`.
  expect(md("![x]() and a ! [y]")).toEqual(["![x]() and a ! [y]"])
})

test("reference-style images and links use the definitions seen so far, which are not shown", () => {
  const text = [
    "[logo]: https://a.dev/logo.png",
    "[Docs]: <https://a.dev/docs> 'The docs'",
    "",
    "![Our logo][logo], ![logo][], ![logo] and [the docs][docs], [docs][], [Docs].",
    "![later][nope] and [text][nope] and [nope].",
  ].join("\n")
  expect(md(text, 200)).toEqual([
    "🖼\uFE0F Our logo (https://a.dev/logo.png), 🖼\uFE0F logo (https://a.dev/logo.png), 🖼\uFE0F logo (https://a.dev/logo.png) and the docs (https://a.dev/docs), docs (https://a.dev/docs), Docs (https://a.dev/docs).",
    "🖼\uFE0F later and [text][nope] and [nope].",
  ])
  // A definition cannot interrupt a paragraph: there it is text.
  expect(md("Some text\n[n]: https://a.dev/n.png\n\n![x][n]", 200)).toEqual([
    "Some text",
    "[n]: https://a.dev/n.png",
    "",
    "🖼\uFE0F x",
  ])
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
  expect(m.render(40, ctx)).toEqual([`│ line${" ".repeat(33)}│`])
  expect(committed).toEqual([`╭${"─".repeat(38)}╮`, `│ line 1${" ".repeat(31)}│`])
  m.append(" 2\n")
  expect(m.render(40, ctx)).toEqual([])
  expect(committed).toEqual([
    `╭${"─".repeat(38)}╮`,
    `│ line 1${" ".repeat(31)}│`,
    `│ line 2${" ".repeat(31)}│`,
  ])
  // Interrupted: the block is closed when the text is taken.
  expect(m.take(40)).toEqual([`╰${"─".repeat(38)}╯`])
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

test("a header line is not committed as a paragraph while its delimiter row is still coming", () => {
  const table = "| col | other |\n|-----|-------|\n| 1 | 2 |\n\nafter\n"
  const heading = "Title\n-----\n\nafter\n"
  for (const text of [`para\n\n${table}`, `para\n\n${heading}`]) {
    // Every chunk boundary: a frame may come at any of them, with the live region too small for
    // the held line, its blank row and the partial line that decides what it is.
    for (let at = 1; at < text.length; at++) {
      const { ctx, committed } = committing()
      const m = new MarkdownStream({ hyperlinks: false })
      m.maxRows = 2
      for (const chunk of [text.slice(0, at), text.slice(at)]) {
        m.append(chunk)
        expect(m.render(40, ctx).length).toBeLessThanOrEqual(2)
      }
      const rows = [...committed, ...m.take(40)].map(stripAnsi)
      // Taller than the live region, the table keeps the widths it had with room to spare.
      const shape = (r: string[]) => r.map((row) => row.replace(/ +│/, " │").replace(/─+┼─+/, "─┼─"))
      expect({ at, rows: shape(rows) }).toEqual({ at, rows: shape(md(text)) })
    }
  }
})

test("a table row too tall for the live region is committed as its source; the table goes on", () => {
  for (const frozenFirst of [true, false]) {
    const { ctx, committed } = committing()
    const m = new MarkdownStream()
    m.maxRows = 3
    const head = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n"
    const long = `| ${"x".repeat(200)} | 5 |`
    if (frozenFirst) {
      m.append(head)
      m.render(40, ctx)
    } else m.append(`${head.split("\n").slice(0, 3).join("\n")}\n`)
    const rest = `${long}\n| 6 | 7 |\n| 8 | 9 |\n`
    for (let at = 0; at < rest.length; at += 5) {
      m.append(rest.slice(at, at + 5))
      expect(m.render(40, ctx).length).toBeLessThanOrEqual(3)
    }
    const rows = [...committed, ...m.take(40)].map(stripAnsi)
    if (frozenFirst)
      expect(rows.slice(0, 4)).toEqual(["a     │ b", "──────┼──────", "1     │ 2", "3     │ 4"])
    const i = rows.indexOf("|")
    // The long row wraps as text, in as many rows as that takes; the next rows are table rows.
    expect(rows.slice(i).join("").replace(/ /g, "")).toBe(`|${"x".repeat(200)}|5|6│78│9`)
    expect(rows.slice(-2)).toEqual(["6     │ 7", "8     │ 9"])
  }
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

/**
 * Streams `text` in chunks of `n`, checking each frame fits `maxRows` (and one more row while the
 * last character, which may still take a combining mark, is what wrapped it); committed plus final rows.
 */
function streamed(
  text: string,
  width: number,
  maxRows: number,
  opts: { n?: number; theme?: boolean; hyperlinks?: boolean } = {},
): string[] {
  const { ctx, committed } = committing()
  const c = opts.theme ? { ...ctx, theme: defaultTheme } : ctx
  const m = new MarkdownStream({ hyperlinks: opts.hyperlinks ?? false })
  m.maxRows = maxRows
  const n = opts.n ?? 3
  for (let at = 0; at < text.length; at += n) {
    m.append(text.slice(at, at + n))
    expect({ at, rows: m.render(width, c).length <= maxRows + 1 }).toEqual({ at, rows: true })
  }
  return [...committed, ...m.take(width)]
}

test("a frozen table followed immediately by a setext marker keeps its cells and the marker", () => {
  const header = "| h1 | h2 |\n|----|:--:|\n"
  const body = "| another cell here | x |\n"
  const rows = replay(
    [
      [header, 1],
      [body, 3],
      ["===", 1],
    ],
    32,
  )
  // Frozen columns wrap independently: x shares the first physical row with part of the first
  // cell, rather than following all of its text. This is table layout, not reordered cell content.
  expect(rows).toEqual(["h1     │   h2", "───────┼───────", "anothe │   x", "r cell │", "here   │", "==="])
  expect(md(`${header}${body}===`, 32)).toEqual([
    "h1                │ h2",
    "──────────────────┼───",
    "another cell here │ x",
    "===",
  ])
})

test("an emphasis marker split between chunks leaves no stray delimiter", () => {
  for (const width of [8, 16, 32]) {
    for (let length = 0; length <= 80; length++) {
      const prefix = "a ".repeat(length)
      const rows = replay(
        [
          [`${prefix}*`, 1],
          ["*bold**", 1],
        ],
        width,
      )
      expect({ width, length, delimiter: rows.some((row) => row.includes("*")) }).toEqual({
        width,
        length,
        delimiter: false,
      })
      expect(letters(rows)).toBe(letters(md(`${prefix}**bold**`, width)))
    }
  }
})

test("a split closing emphasis marker is not committed as a weaker span", () => {
  for (const width of [8, 16, 32]) {
    for (const marker of ["**", "***", "__", "___", "~~"]) {
      const text = `before ${marker}one two three four five six seven eight nine ten${marker} after`
      for (let n = 1; n < marker.length; n++) {
        const at = text.lastIndexOf(marker) + n
        for (const theme of [plain.theme, defaultTheme]) {
          const { ctx, committed } = committing()
          const m = new MarkdownStream({ hyperlinks: false })
          m.maxRows = 1
          for (const chunk of [text.slice(0, at), text.slice(at)]) {
            m.append(chunk)
            expect(m.render(width, { ...ctx, theme }).length).toBeLessThanOrEqual(1)
          }
          expect([...committed, ...m.take(width)]).toEqual(
            renderMarkdown(text, width, theme, { hyperlinks: false }),
          )
        }
      }
    }
  }
})

test("a URL longer than the live region is cut inside, and the rest still shows as the URL", () => {
  const url = `https://example.com/${Array.from({ length: 80 }, (_, i) => `L${i + 1}`).join("/")}`
  const text = `See ${url} for details.\nNext`
  expect(streamed(text, 40, 3)).toEqual(md(text, 40))
  // Complete links and autolinks cut inside their shown URL go on with the rest of it.
  for (const line of [`A [link](${url}) and more.`, `An <${url}> and more.`, `**Bold ${url}** too`]) {
    expect(streamed(line, 40, 2, { n: 400 })).toEqual(md(line, 40))
    // Still open when its rows had to be committed, it keeps the delimiters it had then.
    expect(letters(streamed(line, 40, 2))).toBe(letters(md(line, 40)))
  }
  // A clickable URL's rest links to the whole URL.
  const rows = streamed(text, 40, 3, { hyperlinks: true })
  expect(rows.at(-2)).toContain(`\x1b]8;;${url}\x07`)
})

test("rows are not cut after a delimiter that may still open a span, unless they do not fit", () => {
  const text = "more **bold text that goes on and on closes** and *italic text here* too"
  expect(streamed(text, 15, 4, { theme: true })).toEqual(
    renderMarkdown(text, 15, defaultTheme, { hyperlinks: false }),
  )
  // A delimiter that is never closed is shown as it is.
  const open = "an **opener that is never closed while the line goes on and on and on"
  expect(streamed(open, 15, 2).map(stripAnsi)).toEqual(md(open, 15))
})

test("a code line cut inside a string or comment goes on colored as it was; headings keep their close", () => {
  const code = `\`\`\`ts\nconst s = "${"a".repeat(40)} \\" bbbb" // return if\n\`\`\`\n`
  expect(streamed(code, 30, 1, { theme: true, n: 2 })).toEqual(
    renderMarkdown(code, 30, defaultTheme, { hyperlinks: false }),
  )
  const heading = `# ${Array.from({ length: 30 }, (_, i) => `h${i}`).join(" ")} ##\nafter`
  expect(streamed(heading, 20, 1)).toEqual(md(heading, 20))
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

/** Lines with images, mixed with some of the above. */
const IMAGE_LINES = [
  "![a cat](cat.png) sits and ![dog](http://i.x/dog.jpg)",
  "![cat](http://i.x/c.png)",
  "[![badge](b.svg)](http://ci.x/y)",
  "![pic][] and more",
  "[pic]: http://r.x/pic.png",
  "",
  "plain words in a paragraph that is long enough to wrap around",
  "- item **two**",
  "> quoted *line* here",
  "a [link](http://x.y/z) and https://q.r/s done",
]

function randomDoc(rand: () => number, n: number, lines = LINES): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(lines[Math.floor(rand() * lines.length)]!)
  return out.join("\n")
}

/** Streams `text` in random chunks, rendering after each, and returns committed plus final rows. */
function stream(
  text: string,
  rand: () => number,
  widthOf: () => number,
  maxRowsOf: () => number,
  context = plain,
): { rows: string[]; lives: string[][]; widths: number[] } {
  const { ctx, committed } = committing()
  ctx.theme = context.theme
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
    .filter((row) => {
      const bare = stripAnsi(row).trimStart()
      return !bare.startsWith("╭─") && !(row.trimStart().startsWith(frameOpen) && !bare.startsWith("│"))
    })
    .map(stripAnsi)
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

test("text with images streams like the whole text, also with a small live region", () => {
  for (let seed = 1; seed <= 150; seed++) {
    const rand = rng(seed * 13)
    const text = randomDoc(rand, 15, IMAGE_LINES)
    const width = 6 + Math.floor(rand() * 40)
    const whole = md(text, width)
    expect({
      seed,
      rows: stream(
        text,
        rand,
        () => width,
        () => 1000,
      ).rows.map(stripAnsi),
    }).toEqual({
      seed,
      rows: whole,
    })
    const { rows, lives } = stream(
      text,
      rand,
      () => width,
      () => 1 + Math.floor(rand() * 5),
    )
    expect({ seed, text: letters(rows) }).toEqual({ seed, text: letters(whole) })
    for (const r of [...rows, ...lives.flat()])
      expect({ seed, r, w: visibleWidth(r) <= width }).toEqual({ seed, r, w: true })
  }
})

/** Lines with text-default emoji (two cells unless VS15 follows), mixed with some of the above. */
const EMOJI_LINES = [
  "mail ✉ from ⚠ ops, ❤\uFE0F and © kept",
  "✉✉✉✉✉✉✉✉✉✉✉✉✉✉",
  "| to | from |",
  "|----|------|",
  "| ✉ mail ☑ | ❤ |",
  "- ☑ done ✔ and ✏ edit",
  "> ⚠ careful ☀ out",
  "text ☑\uFE0E stays one cell",
  "",
  "plain words in a paragraph that is long enough to wrap around",
]

test("text with text-default emoji streams like the whole text, and fits once drawn", () => {
  for (let seed = 1; seed <= 150; seed++) {
    const rand = rng(seed * 17)
    const text = randomDoc(rand, 15, EMOJI_LINES)
    const width = 6 + Math.floor(rand() * 40)
    const whole = md(text, width)
    const full = stream(
      text,
      rand,
      () => width,
      () => 1000,
    ).rows.map(stripAnsi)
    expect({ seed, rows: full }).toEqual({ seed, rows: whole })
    const { rows, lives } = stream(
      text,
      rand,
      () => width,
      () => 1 + Math.floor(rand() * 5),
    )
    expect({ seed, text: letters(rows) }).toEqual({ seed, text: letters(whole) })
    for (const r of [...rows, ...lives.flat()]) {
      expect({ seed, r, w: visibleWidth(r) <= width }).toEqual({ seed, r, w: true })
      // As the renderers write it, the terminal takes the cells that were measured.
      expect({ seed, r, w: Bun.stringWidth(presentEmoji(r)) }).toEqual({ seed, r, w: visibleWidth(r) })
    }
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
      labelledContext,
    )
    expect({ seed, text: letters(rows) }).toEqual({ seed, text: letters(md(text, 80, { markFrames: true })) })
    lives.forEach((live, i) => {
      for (const r of live) expect(visibleWidth(r)).toBeLessThanOrEqual(widths[i]!)
    })
  }
})

test("an image cut after its glyph keeps the URL that follows its alt text", () => {
  // The rows break between the glyph and the alt text, and the live region holds one row: the
  // cut goes through the image's run, and its URL (added text at the same place) goes on too.
  // Not about the glyph's width: a one-cell glyph lost the URL the same way.
  for (const [image, width] of [
    [String.fromCodePoint(0x1f5bc, 0xfe0f), 12],
    [String.fromCodePoint(0x1f5bc), 11],
  ] as const) {
    const glyphs = { ...defaultGlyphs, image }
    const chunks = ["sits and ", "![dog](d.jpg)", " ok"]
    const text = chunks.join("")
    const { ctx, committed } = committing()
    const m = new MarkdownStream({ hyperlinks: false, glyphs })
    m.maxRows = 1
    for (const chunk of chunks) {
      m.append(chunk)
      m.render(width, ctx)
    }
    const whole = new MarkdownStream({ hyperlinks: false, glyphs })
    whole.append(text)
    whole.render(width, plain)
    const rows = whole.take(width).map(stripAnsi)
    expect(rows[0]).toBe(`sits and ${image}`)
    expect([...committed, ...m.take(width)].map(stripAnsi)).toEqual(rows)
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

/** Streams `steps` (a chunk and the live region's rows after it) and returns all rows shown. */
function replay(steps: [string, number][], width: number): string[] {
  const { ctx, committed } = committing()
  const m = new MarkdownStream({ hyperlinks: false })
  for (const [chunk, maxRows] of steps) {
    m.append(chunk)
    m.maxRows = maxRows
    m.render(width, ctx)
  }
  return [...committed, ...m.take(width)].map(stripAnsi)
}

test("a table header committed before its delimiter row still starts the table", () => {
  // Too narrow to lay the table out, so it shows as its source either way. With the header
  // committed early as a paragraph, its rows used to be paragraph text, so the `===` after the
  // last one made it a heading and was lost.
  const text = "| h1 | h2 |\n|----|:--:|\n| another cell here | x |\n==="
  const whole = md(text, 9)
  expect(whole.at(-1)).toBe("===")
  // The header held whole, then committed as it does not fit.
  const held: [string, number][] = [
    ["| h1 |", 3],
    [" h2 |\n", 3],
    ["|----", 1],
    ["|:--:|\n", 1],
    ["| another cell here | x |\n", 3],
    ["===", 3],
  ]
  expect(replay(held, 9)).toEqual(whole)
  // The header committed in parts while it came in, and then its delimiter row too.
  const cut: [string, number][] = [
    ["| h1 | h2", 1],
    [" |\n", 1],
    ["|----|:--", 3],
    [":|", 1],
    ["\n| another cell here | x |\n", 3],
    ["===", 3],
  ]
  expect(replay(cut, 9)).toEqual(whole)
})

/** Documents whose blocks a small live region cuts at awkward places. */
const TRICKY = [
  "| h1 | h2 |\n|----|:--:|\n| another cell here | x |\n===",
  "| a | b |\n|---|---|\n| c | d |\n---\nafter",
  "| long header cell | b |\n|---|---|\n| c | d |\nText\n===",
  "Title\n===\n| x | y |\n|--|--|",
]

/** Replies cut off in the middle of a span, and other text that is not a table. */
const PROSE = [
  "some **bold te",
  "a few words here and *an italic span that goes on",
  "x _under and `code that is not closed",
  "- item with **bold\n- and ~~gone",
  "> quoted *it",
  "Heading\n===\nand **more",
]

/** The visible characters, but those that differ between a table laid out and its source. */
const shown = (rows: string[]) => [...rows.join("").replace(/[\s│┼─|:-]/g, "")].sort().join("")

test("streamed in chunks of any size, tricky documents render as they do whole", () => {
  for (const text of [...TRICKY, ...PROSE]) {
    for (const width of [9, 10, 14, 32]) {
      const whole = md(text, width)
      for (let size = 1; size <= 8; size++) {
        const chunks = Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
          text.slice(i * size, (i + 1) * size),
        )
        const wide = replay(
          chunks.map((c) => [c, 1000]),
          width,
        )
        expect({ text, width, size, rows: wide }).toEqual({ text, width, size, rows: whole })
        // The live region keeps one size, or changes size between chunks (as when the view
        // around it changes).
        const sizes: [string, (i: number) => number][] = [
          ["1", () => 1],
          ["2", () => 2],
          ["3", () => 3],
          ["1/3", (i) => (i % 2 ? 3 : 1)],
          ["mixed", (i) => 1 + ((i * 7 + size) % 3)],
        ]
        for (let seed = 1; seed <= 4; seed++) {
          const rand = rng(seed * 101 + size * 7 + width)
          const at = chunks.map(() => 1 + Math.floor(rand() * 3))
          sizes.push([`seed ${seed}`, (i) => at[i]!])
        }
        for (const [maxRows, rowsAt] of sizes) {
          const rows = replay(
            chunks.map((c, i) => [c, rowsAt(i)]),
            width,
          )
          const at = { text, width, size, maxRows }
          // A table taller than the live region keeps the widths it had when committed; the rest
          // renders exactly as it does whole.
          if (PROSE.includes(text)) expect({ ...at, rows }).toEqual({ ...at, rows: whole })
          else expect({ ...at, shown: shown(rows) }).toEqual({ ...at, shown: shown(whole) })
        }
      }
    }
  }
})

test("a reply cut off inside a span is styled as the same text rendered whole", () => {
  // The delimiters of a span that never closed are text, as in the whole render.
  const ctx = { ...plain, theme: defaultTheme, color: true }
  for (const text of PROSE) {
    const whole = renderMarkdown(text, 20, defaultTheme, { hyperlinks: false })
    const committed: string[] = []
    const m = new MarkdownStream({ hyperlinks: false })
    for (let at = 0; at < text.length; at += 3) {
      m.append(text.slice(at, at + 3))
      m.maxRows = 1
      m.render(20, { ...ctx, commit: (rows) => committed.push(...rows) })
    }
    expect({ text, rows: [...committed, ...m.take(20)] }).toEqual({ text, rows: whole })
  }
  expect(md("some **bold te")).toEqual(["some **bold te"])
})
