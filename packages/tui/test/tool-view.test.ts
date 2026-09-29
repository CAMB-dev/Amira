import { expect, test } from "bun:test"
import { type ToolPresenter, textResult } from "@amira/api"
import { builtinPresenters } from "@amira/builtin-tools"
import { defaultTheme, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { parseUnifiedDiff, renderToolLines } from "../src/diff-view.ts"
import { type FinishedCall, finishedToolLines, runningToolLines } from "../src/tool-view.ts"

const theme = defaultTheme
const plain = (l: string[]) => l.map(stripAnsi)
const show = (
  presenter: ToolPresenter | undefined,
  call: FinishedCall,
  detail = "summary" as const,
  width = 60,
) => plain(finishedToolLines(theme, presenter, call, detail, width))

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `out ${i + 1}`).join("\n")

test("a tool without a presenter: its main argument, the first result line and how many more", () => {
  expect(
    show(undefined, {
      name: "mcp_x",
      args: { query: "q", limit: 3 },
      result: textResult("a\nb\nc"),
      durationMs: 1500,
    }),
  ).toEqual(["● mcp_x q · limit=3", "  └ a (+2 lines) · 1.5s"])
})

test("a failure shows its output under the result, its start and end when it is long", () => {
  const call = { name: "mcp_x", args: {}, result: textResult(`boom\n${numbered(20)}`, true) }
  const lines = show(undefined, call)
  expect(lines.slice(0, 2)).toEqual(["✗ mcp_x", "  └ boom (+20 lines)"])
  expect(lines.slice(2)).toEqual([
    "    out 1",
    "    out 2",
    "    out 3",
    "    out 4",
    "    … 13 more lines",
    "    out 18",
    "    out 19",
    "    out 20",
  ])
  // collapsed keeps the result line alone; full shows everything.
  expect(show(undefined, call, "collapsed" as never)).toHaveLength(2)
  expect(show(undefined, call, "full" as never)).toHaveLength(22)
})

test("calls that did not run to completion are muted with their own marker, never the red cross", () => {
  const aborted = show(undefined, {
    name: "bash",
    args: { command: "sleep 9" },
    result: textResult("Aborted by the user before this tool finished.", true),
    rejected: "aborted",
  })
  expect(aborted).toEqual(["⊘ bash sleep 9", "  └ interrupted"])
  const blocked = show(undefined, {
    name: "edit",
    args: { path: "a" },
    result: textResult("Tool call blocked: read-only mode", true),
    rejected: "blocked",
  })
  expect(blocked).toEqual(["⊘ edit a", "  └ Tool call blocked: read-only mode"])
  // A tool that failed because the user interrupted the turn reads as interrupted too.
  const cut = show(undefined, {
    name: "bash",
    args: { command: "x" },
    result: textResult("Command was aborted.", true),
    interrupted: true,
  })
  expect(cut).toEqual(["⊘ bash x", "  └ interrupted"])
  // Nothing of it is red.
  const colored = finishedToolLines(
    theme,
    undefined,
    { name: "bash", args: {}, result: textResult("x", true), rejected: "unknownTool" },
    "summary",
    60,
  ).join("\n")
  expect(colored).not.toContain("\x1b[31m")
})

test("an edit shows +added −removed and a compact numbered diff, cut after 20 lines", () => {
  const hunk = (start: number, n: number) => ({
    oldStart: start,
    oldLines: n,
    newStart: start,
    newLines: n,
    lines: Array.from({ length: n }, (_, i) => `${i % 2 ? "+" : "-"}line ${start + i}`),
  })
  const small = show(builtinPresenters.edit, {
    name: "edit",
    args: { path: "src/a.ts", old_string: "x", new_string: "y" },
    result: {
      content: [{ type: "text", text: "Edited src/a.ts: replaced 1 occurrence" }],
      details: { path: "/p/src/a.ts", replacements: 1, added: 1, removed: 1, hunks: [hunk(9, 2)] },
    },
  })
  expect(small).toEqual(["● edit src/a.ts", "  └ +1 −1", "    9 - line 9", "    9 + line 10"])
  const big = show(builtinPresenters.edit, {
    name: "edit",
    args: { path: "a.ts", old_string: "x", new_string: "y" },
    result: {
      content: [{ type: "text", text: "Edited" }],
      details: { path: "a.ts", replacements: 1, added: 15, removed: 15, hunks: [hunk(1, 30)] },
    },
  })
  expect(big).toHaveLength(2 + 20)
  // The note lines up with the text, past the gutter.
  expect(big.at(-1)).toBe("         … 11 more lines")
})

test("a presenter that throws falls back to the generic presentation", () => {
  const broken: ToolPresenter = {
    summary: () => {
      throw new Error("bad")
    },
    result: () => {
      throw new Error("bad")
    },
  }
  expect(show(broken, { name: "t", args: { path: "p" }, result: textResult("ok") })).toEqual([
    "● t p",
    "  └ ok",
  ])
})

test("finished and running lines fit the width, the running one with spinner and time on the right", () => {
  const long = { command: "x".repeat(300) }
  const done = finishedToolLines(
    theme,
    undefined,
    { name: "bash", args: long, result: textResult("y".repeat(300)) },
    "summary",
    40,
  )
  expect(done.every((l) => visibleWidth(l) <= 40)).toBe(true)
  const running = plain(
    runningToolLines(
      theme,
      undefined,
      { name: "bash", args: { command: "bun test" }, startedAt: 0, partial: textResult("a\n\nb\nc\nd\n") },
      12_400,
      "⠋",
      40,
    ),
  )
  expect(running).toEqual([`● bash bun test${" ".repeat(20)}⠋ 12s`, "  │ b", "  │ c", "  │ d"])
  const narrow = runningToolLines(theme, undefined, { name: "bash", args: long, startedAt: 0 }, 0, "⠋", 30)
  expect(narrow.every((l) => visibleWidth(l) <= 30)).toBe(true)
})

test("diff lines: a unified diff keeps its signs, numbered from its hunk headers", () => {
  const unified = plain(
    renderToolLines(
      parseUnifiedDiff("--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n ctx\n@@ -40,2 +40,2 @@\n x\n-y\n"),
      theme,
      40,
    ),
  )
  // The first hunk's header gives way to the numbers, a later one to "⋯".
  expect(unified).toEqual([
    "--- a/f",
    "+++ b/f",
    " 1 - old",
    " 1 + new",
    " 2   ctx",
    " ⋯",
    "40   x",
    "41 - y",
  ])
  const gutter = plain(
    renderToolLines(
      [
        { kind: "diff-context", text: "a", lineNo: 9 },
        { kind: "diff-add", text: "b", lineNo: 10 },
        { kind: "diff-hunk", text: "⋯" },
      ],
      theme,
      40,
      "  ",
    ),
  )
  expect(gutter).toEqual(["   9   a", "  10 + b", "   ⋯"])
})
