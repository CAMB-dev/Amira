import { expect, test } from "bun:test"
import { stripAnsi } from "../src/ansi.ts"
import type { Component } from "../src/component.ts"
import { MarkdownStream, renderMarkdown } from "../src/components/markdown-stream.ts"
import { LiveRenderer } from "../src/renderer.ts"
import { FakeTerminal } from "../src/terminal.ts"
import { plain } from "./context.ts"
import { VirtualScreen } from "./screen.ts"

function streamScreen(chunks: string[], width: number, maxRows: number) {
  const term = new FakeTerminal(width, maxRows + 1)
  const screen = new VirtualScreen(width, maxRows + 1)
  term.write = (data) => screen.write(data)
  const markdown = new MarkdownStream({ hyperlinks: false })
  markdown.maxRows = maxRows
  const committed: string[] = []
  const root: Component = {
    render(cols, ctx) {
      return markdown.render(cols, {
        ...ctx,
        commit: (rows) => {
          committed.push(...rows)
          ctx.commit!(rows)
        },
      })
    },
  }
  const renderer = new LiveRenderer(term, root, { theme: plain.theme, color: false })
  for (const chunk of chunks) {
    markdown.append(chunk)
    renderer.render()
  }
  const tail = markdown.take(width)
  committed.push(...tail)
  renderer.commit(tail)
  renderer.stop()
  return { screen: screen.text, rows: committed.map(stripAnsi) }
}

const table = "| h1 | h2 |\n|----|:--:|\n| another cell here | x |\n"
const texts = [
  `${table}===`,
  `${table}---`,
  "another cell here\n===",
  "- another cell here\n===",
  `paragraph\n\n${table}===`,
  `- list item\n\n${table}===`,
]

test("streamed Markdown keeps emitted rows in order across the commit/live screen boundary", () => {
  for (const text of texts) {
    for (const width of [24, 32, 40]) {
      for (const maxRows of [1, 2, 3, 4]) {
        const boundaries = Array.from({ length: text.length - 1 }, (_, i) => i + 1)
        const chunks = boundaries.map((at) => [text.slice(0, at), text.slice(at)])
        chunks.push([...text])
        for (const [at, parts] of chunks.entries()) {
          const result = streamScreen(parts, width, maxRows)
          expect({ text, width, maxRows, at, screen: result.screen }).toEqual({
            text,
            width,
            maxRows,
            at,
            screen: result.rows.join("\n"),
          })
        }
      }
    }
  }
})

test("a frozen table wraps each cell in its own column before the trailing marker", () => {
  const header = "| h1 | h2 |\n|----|:--:|\n"
  const body = "| another cell here | x |\n"
  for (const width of [24, 32, 40]) {
    for (const marker of ["===", "---"]) {
      const result = streamScreen([header, body, ...marker], width, 1)
      expect(result.screen).toBe(
        [
          "h1     │   h2",
          "───────┼───────",
          "anothe │   x",
          "r cell │",
          "here   │",
          marker === "===" ? marker : "─".repeat(width),
        ].join("\n"),
      )
    }
  }
})

test("streamed Markdown matches the non-streamed screen when the table has not frozen", () => {
  for (const text of texts) {
    for (const width of [24, 32, 40]) {
      const expected = renderMarkdown(text, width, plain.theme, { hyperlinks: false }).join("\n")
      // A preceding block leaves a pending gap, which also belongs to the live region.
      const maxRows = text.startsWith(table) || !text.includes(table) ? 4 : 5
      for (let at = 1; at < text.length; at++) {
        const result = streamScreen([text.slice(0, at), text.slice(at)], width, maxRows)
        expect({ text, width, at, screen: result.screen }).toEqual({ text, width, at, screen: expected })
      }
      expect(streamScreen([...text], width, maxRows).screen).toBe(expected)
    }
  }
})
