import { expect, test } from "bun:test"
import {
  outputPreview,
  type ThemeDefinition,
  type ToolDetailLevel,
  type ToolPresenter,
  textResult,
} from "@amira/api"
import { createTheme, defaultTheme, monoTheme, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { builtinPresenters } from "../../../extensions/builtin-tools/src/index.ts"
import ascii from "../../cli/themes/ascii.json"
import mono from "../../cli/themes/mono.json"
import type { BlockEnv } from "../src/blocks/base.ts"
import { ExploredBlock, ToolBlock } from "../src/blocks/tool.ts"
import { parseUnifiedDiff, renderToolLines } from "../src/diff-view.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
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
  detail: ToolDetailLevel = "summary",
  width = 60,
) => plain(finishedToolLines(theme, presenter, call, detail, width))

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `out ${i + 1}`).join("\n")

test("compact completions append the whole marked result with two spaces, only when it fits", () => {
  const call = {
    name: "bash",
    args: { command: "bun test" },
    result: textResult("412 pass"),
    durationMs: 3100,
  }
  const compact = "  ├ bash bun test  ✓ 412 pass · 3.1s"
  for (const detail of ["summary", "collapsed"] as const) {
    expect(show(undefined, call, detail, visibleWidth(compact))).toEqual([compact])
    expect(show(undefined, call, detail, 80)).toEqual([compact])
    expect(show(undefined, call, detail, visibleWidth(compact) - 1)).toEqual([
      "  ├ bash bun test",
      "  │  ✓ 412 pass · 3.1s",
    ])
  }
  expect(show(undefined, call, "full", 80)).toEqual(["  ├ bash bun test", "  │  ✓ 412 pass · 3.1s"])
})

test("multiline and wrapping results retain continuation rows rather than flattening or clipping", () => {
  const call = { name: "t", args: {}, result: textResult("ok") }
  expect(show({ result: () => "first\n\nlast" }, call, "summary", 80)).toEqual([
    "  ├ t",
    "  │  ✓ first",
    "  │  ",
    "  │  last",
  ])
  expect(show(undefined, { ...call, result: textResult("blocked\nwhy", true), rejected: "blocked" })).toEqual(
    ["  ├ t", "  │  ⊘ blocked", "  │  why"],
  )
  expect(show({ result: () => "abcdefghijklmno" }, call, "summary", 12)).toEqual([
    "  ├ t",
    "  │  ✓",
    "  │  abcdefg",
    "  │  hijklmn",
    "  │  o",
  ])
  expect(show({ result: () => "done", body: () => [{ kind: "code", text: "one\ntwo" }] }, call)).toEqual([
    "  ├ t  ✓ done",
    "  │  one",
    "  │  two",
  ])
})

test("outcomes remain explicit in NO_COLOR, 16-color and monochrome themes, including ASCII", () => {
  const before = { ...glyphs }
  const themes = [
    createTheme({ env: { NO_COLOR: "1" } }),
    createTheme({ colorDepth: "16", env: {} }),
    createTheme({ definition: mono as ThemeDefinition, colorDepth: "truecolor", env: {} }),
    monoTheme,
  ]
  try {
    for (const overrides of [{}, ascii.glyphs]) {
      setGlyphs(overrides)
      for (const theme of themes) {
        const render = (call: FinishedCall) => plain(finishedToolLines(theme, undefined, call, "summary", 80))
        const call = { name: "t", args: {}, result: textResult("ok") }
        expect(render(call)).toEqual([`  ${glyphs.treeBranch} t  ${glyphs.toolDone} ok`])
        expect(render({ ...call, result: textResult("bad", true) })).toEqual([
          `  ${glyphs.treeBranch} t  ${glyphs.toolFailed} bad`,
        ])
        expect(render({ ...call, rejected: "aborted" })).toEqual([
          `  ${glyphs.treeBranch} t  ${glyphs.toolInterrupted} interrupted`,
        ])
        expect(render({ ...call, rejected: "blocked" })).toEqual([
          `  ${glyphs.treeBranch} t  ${glyphs.toolBlocked} ok`,
        ])
        for (const [rejected, mark] of [
          ["unknownTool", glyphs.toolUnknown],
          ["invalidArgs", glyphs.toolInvalid],
        ] as const) {
          expect(mark).not.toBe(glyphs.toolFailed)
          expect(render({ ...call, rejected })).toEqual([`  ${glyphs.treeBranch} t  ${mark} ok`])
        }
        expect(render({ ...call, result: textResult("partial", true), interrupted: true })).toEqual([
          `  ${glyphs.treeBranch} t  ${glyphs.toolInterrupted} interrupted`,
          `  ${glyphs.treeBranch.length === 1 ? "│  " : "|   "}partial`,
        ])
      }
    }
  } finally {
    setGlyphs(before)
  }
})

test("a presenter that already starts with the current outcome mark does not get a duplicate", () => {
  const before = { ...glyphs }
  try {
    for (const overrides of [{}, ascii.glyphs]) {
      setGlyphs(overrides)
      for (const isError of [false, true]) {
        const mark = isError ? glyphs.toolFailed : glyphs.toolDone
        const call = { name: "t", args: {}, result: textResult("ok", isError) }
        expect(show({ result: () => `${mark} done` }, call)).toEqual([
          `  ${glyphs.treeBranch} t  ${mark} done`,
        ])
      }
      const call = {
        name: "t",
        args: {},
        result: textResult(`${glyphs.toolInterrupted} interrupted`, true),
        interrupted: true,
      }
      expect(show({ result: () => `${glyphs.toolInterrupted} interrupted` }, call)).toEqual([
        `  ${glyphs.treeBranch} t  ${glyphs.toolInterrupted} interrupted`,
      ])
    }
  } finally {
    setGlyphs(before)
  }
})

test("sub-agent insertion after the head preserves compact results and every expanded output row", () => {
  const block = new ToolBlock("call", "t", {}, "session")
  block.end = { result: textResult("done") }
  const env: BlockEnv = {
    theme: monoTheme,
    width: 80,
    now: 0,
    spinner: "*",
    detail: "summary",
    hyperlinks: false,
    presenters: undefined,
    nodes: new Map([
      [
        "child",
        {
          id: "child",
          parent: "session",
          toolCallId: "call",
          title: "child",
          role: "agent",
          depth: 1,
          startedAt: 0,
          tokens: 0,
          end: { status: "done", durationMs: 1000, tokens: 0 },
        },
      ],
    ]),
  }
  const compact = plain(block.lines(env))
  expect(compact[0]).toBe("  ├ t  ✓ done")
  expect(compact[1]).toContain("child")
  expect(compact).toHaveLength(2)
  block.end = { result: textResult("one\ntwo\nthree") }
  const expanded = plain(block.lines({ ...env, detail: "full" }))
  expect(expanded[0]).toBe("  ├ t")
  expect(expanded[1]).toContain("child")
  expect(expanded.slice(2)).toEqual(["  │  ✓ one (+2 lines)", "  │  two", "  │  three"])
  const inline = plain(finishedToolLines(monoTheme, undefined, block.finished(), "full", 80))
  inline.splice(1, 0, "  │  child")
  expect(inline).toEqual(["  ├ t", "  │  child", "  │  ✓ one (+2 lines)", "  │  two", "  │  three"])
})

test("a tool without a presenter: its main argument, the first result line and how many more", () => {
  expect(
    show(undefined, {
      name: "mcp_x",
      args: { query: "q", limit: 3 },
      result: textResult("a\nb\nc"),
      durationMs: 1500,
    }),
  ).toEqual(["  ├ mcp_x q · limit=3  ✓ a (+2 lines) · 1.5s"])
})

test("a large output saved as an artifact: its preview's own lines show as short notes", () => {
  const text = numbered(3000)
  const preview = outputPreview({
    text,
    artifact: {
      id: "a_0123456789",
      path: "/s/x.assets/outputs/a_0123456789.txt",
      tool: "mcp_x",
      sessionId: "s",
      chars: text.length,
      lines: 3000,
      bytes: text.length,
      complete: true,
      createdAt: "",
    },
    previewChars: 1200,
  })
  const saved = `… output saved as a_0123456789 · 3,000 lines · ${text.length.toLocaleString("en-US")} chars`
  const call = { name: "mcp_x", args: {}, result: textResult(preview) }
  const lines = show(undefined, call, "full", 80)
  expect(lines[1]).toBe("  │  ✓ 3,000 lines · saved as a_0123456789")
  // The header is the result line's to say; the body starts with the output.
  expect(lines[2]).toBe("  │  out 1")
  expect(lines.some((l) => /^ {2}│ {2}… [\d,]+ lines omitted \(\d+–\d+\)$/.test(l))).toBe(true)
  expect(lines.at(-1)).toBe("  │  out 3000")
  // A shell command's preview under its result, in full and in the summary view.
  const shell = {
    name: "bash",
    args: { command: "make" },
    result: { ...textResult(`${preview}\n\nExit code: 0`), details: { exitCode: 0, outputLines: 3000 } },
  }
  const full = show(builtinPresenters.bash, shell, "full", 80)
  expect(full[1]).toStartWith("  │  ✓ 3000 lines")
  expect(full[2]).toBe(`  │  ${saved}`)
  expect(full.join("\n")).not.toContain("[Output saved")
  expect(show(builtinPresenters.bash, shell).at(-1)).toBe("  │  out 3000")
})

test("a failure shows its output under the result, its start and end when it is long", () => {
  const call = { name: "mcp_x", args: {}, result: textResult(`boom\n${numbered(20)}`, true) }
  const lines = show(undefined, call)
  expect(lines.slice(0, 1)).toEqual(["  ├ mcp_x  ✗ boom (+20 lines)"])
  expect(lines.slice(1)).toEqual([
    "  │  out 1",
    "  │  out 2",
    "  │  out 3",
    "  │  out 4",
    "  │  … 13 more lines",
    "  │  out 18",
    "  │  out 19",
    "  │  out 20",
  ])
  // collapsed keeps the result line alone; full shows everything.
  expect(show(undefined, call, "collapsed")).toHaveLength(1)
  expect(show(undefined, call, "full")).toHaveLength(22)
})

test("calls that did not run to completion are muted with their own marker, never the red cross", () => {
  const aborted = show(undefined, {
    name: "bash",
    args: { command: "sleep 9" },
    result: textResult("Aborted by the user before this tool finished.", true),
    rejected: "aborted",
  })
  expect(aborted).toEqual(["  ├ bash sleep 9  ⊘ interrupted"])
  const blocked = show(undefined, {
    name: "edit",
    args: { path: "a" },
    result: textResult("Tool call blocked: read-only mode", true),
    rejected: "blocked",
  })
  expect(blocked).toEqual(["  ├ edit a  ⊘ Tool call blocked: read-only mode"])
  // A tool that failed because the user interrupted the turn reads as interrupted too.
  const cut = show(undefined, {
    name: "bash",
    args: { command: "x" },
    result: textResult("Command was aborted.", true),
    interrupted: true,
  })
  expect(cut).toEqual(["  ├ bash x  ⊘ interrupted", "  │  Command was aborted."])
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

test("a call rejected at its approval prompt reads as interrupted or blocked, with the command named", () => {
  // What the live view makes of the tool.execute.end of a question dismissed (aborted) or
  // answered no (blocked): the saved result's text is the same, the rejection says which.
  const dismissed = show(builtinPresenters.bash, {
    name: "bash",
    args: { command: "npm publish" },
    result: textResult("Aborted by the user before this tool ran.", true),
    rejected: "aborted",
  })
  expect(dismissed).toEqual(["  ├ bash npm publish  ⊘ interrupted"])
  const saidNo = show(builtinPresenters.bash, {
    name: "bash",
    args: { command: "npm publish" },
    result: textResult("Tool call not approved: the user said no.", true),
    rejected: "blocked",
  })
  expect(saidNo).toEqual(["  ├ bash npm publish", "  │  ⊘ Tool call not approved: the user said no."])
  // Without the rejection (a session stored before it was kept) the same text is a failure.
  const before = show(builtinPresenters.bash, {
    name: "bash",
    args: { command: "npm publish" },
    result: textResult("Aborted by the user before this tool ran.", true),
  })
  expect(before[0]).toBe("  ├ bash npm publish")
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
  expect(small).toEqual(["  ├ edit src/a.ts  ✓ +1 -1", "  │  9 - line 9", "  │  9 + line 10"])
  const big = show(builtinPresenters.edit, {
    name: "edit",
    args: { path: "a.ts", old_string: "x", new_string: "y" },
    result: {
      content: [{ type: "text", text: "Edited" }],
      details: { path: "a.ts", replacements: 1, added: 15, removed: 15, hunks: [hunk(1, 30)] },
    },
  })
  expect(big).toHaveLength(1 + 20)
  // The note lines up with the text, past the gutter.
  expect(big.at(-1)).toBe("  │       … 11 more lines")
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
    "  ├ t p  ✓ ok",
  ])
})

test("finished and running lines fit the width, the running one with spinner after the tree and time on the right", () => {
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
  expect(running).toEqual([`  ├ ⠋ bash bun test${" ".repeat(18)}12s`, "  │  b", "  │  c", "  │  d"])
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
    "  ├ read gone.ts  ✗ File not found: gone.ts (+1 line)",
    "  │  Did you mean done.ts?",
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
  expect(head).toStartWith("  ├ read packages/")
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
  expect(running.slice(1)).toEqual(["  │  99%", "  │  a   b", "  │  ax"])
})

test("on a narrow screen the result and time wrap under the head without exceeding the width", () => {
  const lines = finishedToolLines(
    theme,
    undefined,
    { name: "t", args: {}, result: textResult("some result text"), durationMs: 12_000 },
    "summary",
    14,
  )
  expect(lines.every((l) => visibleWidth(l) <= 14)).toBe(true)
  expect(plain(lines)).toEqual(["  ├ t", "  │  ✓ some", "  │  result", "  │  text ·", "  │  12.0s"])
})

test("an MCP tool's head names its server, muted, and a JSON answer is summed up", () => {
  const lines = finishedToolLines(
    theme,
    undefined,
    { name: "mcp__github__search_issues", args: { query: "bug" }, result: textResult('[{"a":1},{"a":2}]') },
    "summary",
    60,
  )
  expect(plain(lines)).toEqual(["  ├ github · search_issues bug  ✓ 2 items"])
  expect(lines[0]).toContain(theme.muted("github ·"))
  const wrapped = show(undefined, {
    name: "mcp__x__list",
    args: {},
    result: textResult('{"issues":[1,2,3],"total":3}'),
  })
  expect(wrapped).toEqual(["  ├ x · list  ✓ 3 items (issues)"])
})

test("a call that never ran appends its marked rejection without a trailing blank", () => {
  const [head] = show(undefined, {
    name: "nope",
    args: {},
    result: textResult("Unknown tool", true),
    rejected: "unknownTool",
  })
  expect(head).toBe("  ├ nope  ⊘ Unknown tool")
})

test("successful exploring calls read as one row: what was done, in order, each target once", () => {
  const calls = [
    { name: "read", args: { path: "a.ts" } },
    { name: "read", args: { path: "b.ts" } },
    { name: "grep", args: { pattern: "foo" } },
    { name: "read", args: { path: "a.ts" } },
  ].map((c) => ({ call: { ...c, result: textResult("x") }, presenter: builtinPresenters[c.name] }))
  expect(plain(exploredLines(theme, calls, false, "summary", 80))).toEqual([
    "  ├ Explored · Read a.ts, b.ts · Search foo",
  ])
  // Unfolded, each call under it.
  const open = plain(exploredLines(theme, calls, true, "summary", 80))
  expect(open[1]).toBe("  │   ├ read a.ts")
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

test("a failure whose one line of output is its result line says it once", () => {
  const text = "Aborted by the user before this tool ran."
  const call: FinishedCall = {
    name: "bash",
    args: { command: "make clean" },
    result: { content: [{ type: "text", text }], isError: true },
  }
  const lines = show(builtinPresenters.bash, call)
  expect(lines.filter((l) => l.includes(text))).toHaveLength(1)
  expect(lines).toEqual(["  ├ bash make clean", "  │  ✗ Aborted by the user before this tool ran."])
})

test("views can change the last tool flag without leaving cached tree rows stale", () => {
  const call = new ToolBlock("call", "read", { path: "a.ts" }, "session")
  for (const block of [call, new ExploredBlock([call])]) {
    expect(block.last).toBe(false)
    const version = block.version
    block.last = true
    expect(block.version).toBe(version + 1)
    block.last = true
    expect(block.version).toBe(version + 1)
    block.last = false
    expect(block.version).toBe(version + 2)
  }
})

test("tool trees close their last sibling and continue beside wrapped diffs in Unicode and ASCII", () => {
  const before = { ...glyphs }
  const presenter: ToolPresenter = {
    summary: () => "src/界.ts",
    result: () => "updated",
    body: () => [{ kind: "diff-add", text: "界".repeat(40), lineNo: 12 }],
  }
  const call = { name: "edit", args: { path: "src/界.ts" }, result: textResult("ok") }
  try {
    for (const [branch, last, pipe] of [
      ["├", "└", "│"],
      ["|-", "`-", "|"],
    ] as const) {
      setGlyphs({ treeBranch: branch, treeLast: last, treePipe: pipe })
      for (const width of [1, 3, 8, 24, 60]) {
        for (const isLast of [false, true]) {
          const rows = finishedToolLines(theme, presenter, call, "full", width, { last: isLast })
          expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)
          if (width < 24) continue
          const shown = plain(rows)
          expect(shown[0]).toBe(`  ${isLast ? last : branch} edit src/界.ts`)
          const prefix = branch === "├" ? (isLast ? "     " : "  │  ") : isLast ? "      " : "  |   "
          expect(shown[1]).toBe(`${prefix}✓ updated`)
          expect(shown.slice(2).every((row) => row.startsWith(prefix))).toBe(true)
          expect(shown.length).toBeGreaterThan(3)
        }
      }
      const running = plain(
        runningToolLines(
          theme,
          undefined,
          {
            name: "bash",
            args: { command: "make" },
            startedAt: 0,
            partial: textResult("output"),
          },
          1000,
          "*",
          24,
          { last: true },
        ),
      )
      expect(running[0]).toStartWith(`  ${last} * bash make`)
      expect(running[1]).toBe(`${branch === "├" ? "     " : "      "}output`)
    }
  } finally {
    setGlyphs(before)
  }
})

test("a finished shell command shows as many lines by default as while it ran", async () => {
  const { OUTPUT_LINES, RUNNING_LINES } = await import("../src/tool-view.ts")
  expect(OUTPUT_LINES).toBe(RUNNING_LINES)
})
