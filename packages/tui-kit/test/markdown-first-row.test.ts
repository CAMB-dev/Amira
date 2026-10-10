import { expect, test } from "bun:test"
import { MarkdownStream, renderMarkdown, stripAnsi, visibleWidth, wrapText } from "../src/index.ts"
import { plain } from "./context.ts"

const options = { hyperlinks: false, highlight: false, firstRowWidth: 10 }

test("only the first rendered row reserves space, including within a source line", () => {
  const source = `abcdefghij${"k".repeat(40)}\n\n${"z".repeat(20)}`
  expect(renderMarkdown(source, 20, plain.theme, options)).toEqual([
    "abcdefghij",
    "k".repeat(20),
    "k".repeat(20),
    "",
    "z".repeat(20),
  ])
  expect(wrapText("x".repeat(50), 20, 10)).toEqual(["x".repeat(10), "x".repeat(20), "x".repeat(20)])
})

test("first-row text wrapping preserves styles, wide graphemes and subsequent source lines", () => {
  const rows = wrapText(`\x1b[31m${"界".repeat(15)}\x1b[39m\n${"z".repeat(20)}`, 20, 10)
  expect(rows.map(stripAnsi)).toEqual(["界".repeat(5), "界".repeat(10), "z".repeat(20)])
  expect(rows[0]).toStartWith("\x1b[31m")
  expect(rows[1]).toStartWith("\x1b[31m")
  const source = `[id]: https://example.com\n\n${"x".repeat(30)}`
  expect(renderMarkdown(source, 20, plain.theme, options)).toEqual(["x".repeat(10), "x".repeat(20)])
})

test("partial streaming commits leave the remainder at full width", () => {
  const stream = new MarkdownStream(options)
  stream.maxRows = 1
  const rows: string[] = []
  stream.append("x".repeat(100))
  const live = stream.render(20, { ...plain, commit: (r) => rows.push(...r) })
  expect(rows[0]).toBe("x".repeat(10))
  expect(rows.slice(1).every((row) => visibleWidth(row) === 20)).toBe(true)
  expect([...rows, ...live].join("")).toBe("x".repeat(100))
})

test("code body and table body keep the full width after the first row", () => {
  const code = renderMarkdown(`\`\`\`txt\n${"x".repeat(18)}\n\`\`\``, 20, plain.theme, options)
  expect(code[1]).toBe(`│ ${"x".repeat(18)}`)
  const source = "| title | second |\n| --- | --- |\n| abcdefghij | klmnop |"
  const table = renderMarkdown(source, 20, plain.theme, options)
  const full = renderMarkdown(source, 20, plain.theme, { hyperlinks: false })
  expect(table.slice(-2)).toEqual(full.slice(-2))
  expect(visibleWidth(table[0]!)).toBeLessThanOrEqual(10)
  expect(table.every((row) => visibleWidth(row) <= 20)).toBe(true)
})

test("streaming commits consume the first-row width once and take resets it", () => {
  const stream = new MarkdownStream(options)
  const committed: string[] = []
  const ctx = { ...plain, commit: (rows: string[]) => committed.push(...rows) }
  stream.append(`${"x".repeat(50)}\n\n`)
  stream.render(20, ctx)
  expect(committed.map(stripAnsi)).toEqual(["x".repeat(10), "x".repeat(20), "x".repeat(20)])
  stream.append("z".repeat(20))
  expect(stream.render(20, ctx).map(stripAnsi)).toEqual(["", "z".repeat(20)])
  expect(stream.take(20).map(stripAnsi)).toEqual(["", "z".repeat(20)])
  stream.append("a".repeat(30))
  expect(stream.take(20).map(stripAnsi)).toEqual(["a".repeat(10), "a".repeat(20)])
})
