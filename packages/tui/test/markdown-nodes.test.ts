import { expect, test } from "bun:test"
import type { ViewLine } from "@amira/api"
import { defaultTheme, stripAnsi } from "@amira/tui-kit"
import { nodeRows } from "../src/markdown-nodes.ts"
import { renderViewLines } from "../src/view-lines.ts"

test("markdown nodes retain plain code and single-row diff rendering", () => {
  const rows = nodeRows(
    [
      { kind: "code", text: "\x1b[31mplain\x1b[0m  " },
      { kind: "diff-add", text: "added", lineNo: 42 },
      { kind: "diff-context", text: "context" },
      { kind: "text", text: "a very long line" },
    ],
    defaultTheme,
    8,
  )
  expect(rows[0]).toBe("plain")
  expect(rows[1]).toBe(defaultTheme.success("added"))
  expect(rows[2]).toBe(defaultTheme.muted("context"))
  expect(rows.map(stripAnsi)).toEqual(["plain", "added", "context", "a very …"])
})

test("markdown nodes delegate segments and user messages to the shared view renderer", () => {
  const lines: ViewLine[] = [
    {
      kind: "segments",
      parts: [
        { kind: "accent", text: "Title " },
        { kind: "muted", text: "detail" },
      ],
    },
    { kind: "user-message", text: "a message that needs to wrap", note: "sent earlier" },
  ]
  expect(nodeRows(lines, defaultTheme, 12)).toEqual(renderViewLines(lines, defaultTheme, 12))
})
