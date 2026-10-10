import { expect, test } from "bun:test"
import { stripAnsi } from "../src/ansi.ts"
import { renderMarkdown } from "../src/components/markdown-stream.ts"
import { Spinner } from "../src/components/spinner.ts"
import { defaultTheme, fg256, monoTheme, type Theme } from "../src/style.ts"
import { visibleWidth } from "../src/width.ts"

const theme: Theme = { ...defaultTheme, path: fg256(101), command: fg256(102), shimmer: fg256(103) }

test("inline code follows command while preserving monochrome backticks", () => {
  const rows = renderMarkdown("Run `bun test`.", 80, theme)
  expect(rows[0]).toContain(theme.command("bun test"))
  expect(rows.map(stripAnsi)).toEqual(["Run bun test."])
  expect(renderMarkdown("Run `bun test`.", 80, monoTheme).map(stripAnsi)).toEqual(["Run `bun test`."])
})

test("file links use path while web and fragment links retain link styling", () => {
  for (const url of ["src/file.ts", "./file.ts", "/tmp/file.ts", "file:///tmp/file.ts", "C:/src/file.ts"]) {
    const rows = renderMarkdown(`[source](${url})`, 80, theme, { hyperlinks: false })
    expect(rows[0]).toContain(theme.path("source"))
    expect(rows[0]).toContain(theme.path(` (${url})`))
    expect(rows.map(stripAnsi)).toEqual([`source (${url})`])
  }
  for (const url of ["https://example.com", "//example.com", "mailto:team@example.com", "#section"]) {
    const rows = renderMarkdown(`[source](${url})`, 80, theme, { hyperlinks: false })
    expect(rows[0]).toContain(theme.link!("source"))
    expect(rows[0]).not.toContain(theme.path("source"))
  }
})

test("file link colors retain clickable targets and wrapping", () => {
  const source = "[source file](src/file.ts)"
  const clickable = renderMarkdown(source, 80, theme, { hyperlinks: true })
  expect(clickable[0]).toContain(theme.path("\x1b]8;;src/file.ts\x07source file\x1b]8;;\x07"))
  const rows = renderMarkdown(source, 8, theme, { hyperlinks: false })
  expect(rows.map(stripAnsi)).toEqual(
    renderMarkdown(source, 8, defaultTheme, { hyperlinks: false }).map(stripAnsi),
  )
  expect(rows.every((row) => visibleWidth(row) <= 8)).toBe(true)
})

test("spinner frames follow shimmer without changing the label or width", () => {
  const spinner = new Spinner({ frames: ["⠋"], label: "working" })
  const rows = spinner.render(80, { theme, color: true, rows: 24 })
  expect(rows[0]).toBe(`${theme.shimmer("⠋")} ${theme.muted("working")}`)
  expect(rows.map(stripAnsi)).toEqual(["⠋ working"])
})
