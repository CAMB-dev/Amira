import { expect, test } from "bun:test"
import { fg256, MarkdownStream, renderMarkdown, stripAnsi, visibleWidth } from "../src/index.ts"
import { plain } from "./context.ts"

const theme = {
  ...plain.theme,
  accent: fg256(45),
  heading1: fg256(111),
  heading: fg256(112),
  subheading: fg256(113),
}
const options = { hyperlinks: false, headingMarkers: true }

test("heading markers opt in to accent while text retains its existing heading token", () => {
  const source = "# One\n## Two ##\n### Three\n#### Four\nText\n===\nMore\n---"
  expect(renderMarkdown(source, 40, theme, options)).toEqual([
    theme.accent("# ") + theme.heading1("One"),
    "",
    theme.accent("## ") + theme.heading("Two"),
    "",
    theme.accent("### ") + theme.subheading("Three"),
    "",
    theme.accent("#### ") + theme.subheading("Four"),
    "",
    theme.accent("# ") + theme.heading1("Text"),
    "",
    theme.accent("## ") + theme.heading("More"),
  ])
  const without = renderMarkdown(source, 40, theme, { hyperlinks: false })
  expect(without.map(stripAnsi)).toEqual(["One", "", "Two", "", "Three", "", "Four", "", "Text", "", "More"])
  expect(without).toEqual(renderMarkdown(source, 40, theme, { ...options, headingMarkers: false }))
})

test("heading markers consume the first-row budget only once and wrap with the text", () => {
  const rows = renderMarkdown("### abcd efghijklmnop\n\n## next", 12, theme, {
    ...options,
    firstRowWidth: 8,
  })
  expect(rows.map(stripAnsi)).toEqual(["### abcd", "efghijklmnop", "", "## next"])
  expect(rows[0]).toBe(theme.accent("### ") + theme.subheading("abcd"))
  expect(rows[1]).toBe(theme.subheading("efghijklmnop"))
  expect(visibleWidth(rows[0]!)).toBe(8)
  expect(visibleWidth(rows[1]!)).toBe(12)
})

test("streamed headings preserve ANSI and wrapping parity under partial-commit pressure", () => {
  const source = "### abcdefghijklmnopqrstuvwxyz 界界界 and more text\n\n# Next heading\n"
  for (const width of [1, 2, 3, 4, 7, 12, 24]) {
    for (const firstRowWidth of [1, Math.max(1, width - 3), width]) {
      const opts = { ...options, firstRowWidth }
      const expected = renderMarkdown(source, width, theme, opts)
      for (const chunkSize of [1, 5, source.length]) {
        const stream = new MarkdownStream(opts)
        stream.maxRows = 1
        const committed: string[] = []
        const ctx = { ...plain, theme, commit: (rows: string[]) => committed.push(...rows) }
        for (let i = 0; i < source.length; i += chunkSize) {
          stream.append(source.slice(i, i + chunkSize))
          stream.render(width, ctx)
        }
        const rows = [...committed, ...stream.take(width)]
        expect(rows).toEqual(expected)
        expect(rows[0] && visibleWidth(rows[0])).toBeLessThanOrEqual(firstRowWidth)
        // A two-cell grapheme can occupy a one-cell terminal's entire row.
        expect(rows.slice(1).every((row) => visibleWidth(row) <= Math.max(2, width))).toBe(true)
      }
    }
  }
})

test("live heading previews and take agree with complete rendering", () => {
  for (const source of ["# title", "## **bold** and `code` ##", "### 界界 long title", "#", "setext\n==="]) {
    const stream = new MarkdownStream(options)
    for (const char of source) {
      stream.append(char)
      stream.render(12, { ...plain, theme })
    }
    const expected = renderMarkdown(source, 12, theme, options)
    expect(stream.render(12, { ...plain, theme })).toEqual(expected)
    expect(stream.take(12)).toEqual(expected)
  }
})
