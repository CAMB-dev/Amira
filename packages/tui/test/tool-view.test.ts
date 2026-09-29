import { expect, test } from "bun:test"
import { type ToolPresenter, textResult } from "@amira/api"
import { builtinPresenters } from "@amira/builtin-tools"
import { defaultTheme, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { parseUnifiedDiff, renderToolLines } from "../src/diff-view.ts"
import {
  explorationOf,
  exploredLines,
  type FinishedCall,
  finishedToolLines,
  relativePaths,
  runningToolLines,
} from "../src/tool-view.ts"

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
  expect(cut).toEqual(["⊘ bash x", "  └ interrupted", "    Command was aborted."])
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
  expect(small).toEqual(["● edit src/a.ts", "  └ +1 -1", "    9 - line 9", "    9 + line 10"])
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

test("a failed built-in call shows why under its result, whatever its presenter shows", () => {
  const lines = show(builtinPresenters.read, {
    name: "read",
    args: { path: "gone.ts" },
    result: textResult("File not found: gone.ts\nDid you mean done.ts?", true),
  })
  expect(lines).toEqual([
    "✗ read gone.ts",
    "  └ File not found: gone.ts (+1 line)",
    "    Did you mean done.ts?",
  ])
})

test("a long path in the head is cut in its middle, keeping the file name; the working directory goes", () => {
  const deep = `${process.cwd()}/packages/some/very/deep/folder/structure/that/goes/on/file-name.ts`
  const [head] = show(
    builtinPresenters.read,
    { name: "read", args: { path: deep }, result: textResult("") },
    "summary",
    50,
  )
  expect(head).toStartWith("● read packages/")
  expect(head).toEndWith("/file-name.ts")
  expect(head).toContain("…")
  expect(visibleWidth(head!)).toBeLessThanOrEqual(50)
})

test("only a path that starts with the working directory is made relative", () => {
  const cwd = ["/home/me/", "/home/me\\"]
  expect(relativePaths("/home/me/src/a.ts", cwd, false)).toBe("src/a.ts")
  expect(relativePaths('grep "x" /home/me/src', cwd, false)).toBe('grep "x" src')
  // Inside another path, the same letters are not the working directory.
  expect(relativePaths("/mnt/home/me/src/a.ts", cwd, false)).toBe("/mnt/home/me/src/a.ts")
  // Windows paths ignore case.
  expect(relativePaths("d:\\Dev\\app\\src\\a.ts", ["D:\\dev\\app\\"], true)).toBe("src\\a.ts")
})

test("progress output rewritten with carriage returns shows as the terminal left it, tabs at their stops", () => {
  const running = plain(
    runningToolLines(
      theme,
      undefined,
      { name: "bash", args: {}, startedAt: 0, partial: textResult("0%\r10%\r45%\r99%\r\na\tb\nabc\b\bx") },
      0,
      "⠋",
      40,
    ),
  )
  expect(running.slice(1)).toEqual(["  │ 99%", "  │ a   b", "  │ ax"])
})

test("on a narrow screen the result line still fits, the time given up first", () => {
  const lines = finishedToolLines(
    theme,
    undefined,
    { name: "t", args: {}, result: textResult("some result text"), durationMs: 12_000 },
    "summary",
    14,
  )
  expect(lines.every((l) => visibleWidth(l) <= 14)).toBe(true)
})

test("an MCP tool's head names its server, muted, and a JSON answer is summed up", () => {
  const lines = finishedToolLines(
    theme,
    undefined,
    { name: "mcp__github__search_issues", args: { query: "bug" }, result: textResult('[{"a":1},{"a":2}]') },
    "summary",
    60,
  )
  expect(plain(lines)).toEqual(["● github · search_issues bug", "  └ 2 items"])
  expect(lines[0]).toContain(theme.muted("github ·"))
  const wrapped = show(undefined, {
    name: "mcp__x__list",
    args: {},
    result: textResult('{"issues":[1,2,3],"total":3}'),
  })
  expect(wrapped[1]).toBe("  └ 3 items (issues)")
})

test("a call that never ran has no blank after its name", () => {
  const [head] = show(undefined, {
    name: "nope",
    args: {},
    result: textResult("Unknown tool", true),
    rejected: "unknownTool",
  })
  expect(head).toBe("⊘ nope")
})

test("successful exploring calls read as one row: what was done, in order, each target once", () => {
  const calls = [
    { name: "read", args: { path: "a.ts" } },
    { name: "read", args: { path: "b.ts" } },
    { name: "grep", args: { pattern: "foo" } },
    { name: "read", args: { path: "a.ts" } },
  ].map((c) => ({ call: { ...c, result: textResult("x") }, presenter: builtinPresenters[c.name] }))
  expect(plain(exploredLines(theme, calls, false, "summary", 80))).toEqual([
    "● Explored · Read a.ts, b.ts · Search foo",
  ])
  // Unfolded, each call under it.
  const open = plain(exploredLines(theme, calls, true, "summary", 80))
  expect(open[1]).toBe("  ● read a.ts")
  expect(open).toHaveLength(1 + 4 * 2)
  // A failed one is no exploring: it keeps its own lines.
  const failed = { name: "read", args: { path: "c.ts" }, result: textResult("gone", true) }
  expect(explorationOf(builtinPresenters.read, failed)).toBeUndefined()
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
