import { expect, test } from "bun:test"
import { textResult } from "@amira/api"
import { createTheme, defaultTheme, stripAnsi } from "@amira/tui-kit"
import { subagentEndLine, subagentRows, userLines } from "../src/format.ts"
import { setGlyphs } from "../src/glyphs.ts"
import { treeRows } from "../src/subagents.ts"
import { finishedToolLines, runningToolLines } from "../src/tool-view.ts"

const sub = {
  title: "List and summarise files",
  role: "explorer",
  depth: 1,
  startedAt: 0,
  tokens: 31_000,
  activity: { name: "bash", summary: "cd src && ls" },
}

for (const variant of ["dark", "light"] as const) {
  test(`${variant}: tree guides use the visible gray token, not dim`, () => {
    const theme = createTheme({ theme: variant, colorDepth: "truecolor", color: true, platform: "linux" })
    const rows = finishedToolLines(
      theme,
      undefined,
      { name: "read", args: {}, result: textResult("ok") },
      "summary",
      80,
    )
    expect(rows[0]).toContain(theme.muted("├"))
    expect(rows[0]).not.toContain(theme.dim("├"))
    const running = runningToolLines(
      theme,
      undefined,
      { name: "read", args: {}, startedAt: 0, partial: textResult("live") },
      6000,
      "*",
      80,
    )
    expect(running[0]).not.toContain("├")
    expect(running[1]).toBe(`    ${theme.muted("│")} ${theme.muted("live")}`)
    const children = subagentRows(sub, 6000, 80, theme, false)
    expect(children[0]).toContain(theme.muted("  ├"))
  })
}

test("sub-agent trees put the spinner after each running arm and status before finished titles", () => {
  const rows = treeRows([{ ...sub, id: "child", parent: "main" }], 6000, 80, defaultTheme)
  expect(rows.map(stripAnsi)[0]).toMatch(
    /^ {2}└ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] List and summarise files · explorer · 6s · 31k tok$/,
  )
  expect(rows.map(stripAnsi)[1]).toMatch(/^ {4}└ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] bash cd src && ls$/)
  const end = { status: "done" as const, durationMs: 6000, tokens: 31_000 }
  expect(stripAnsi(subagentEndLine(sub, end, 100, defaultTheme))).toBe(
    "  └ ✓ List and summarise files · explorer · 6.0s · 31k tok",
  )
  expect(
    stripAnsi(subagentEndLine(sub, { ...end, status: "error", error: "failed" }, 100, defaultTheme)),
  ).toStartWith("  └ ✗ List")
  const notice = userLines(
    defaultTheme,
    {
      role: "user",
      content: [],
      display: { origin: "subagent", text: "◆ List and summarise files ✓ explorer · 6s · 31k tok" },
    },
    100,
  )
  expect(notice.map(stripAnsi)).toEqual(["  └ ✓ List and summarise files · explorer · 6s · 31k tok"])
})

test("ASCII sub-agent trees keep their two-cell arms and nested tool indentation", () => {
  setGlyphs({ treeBranch: "|-", treeLast: "`-", treePipe: "|", subagentDone: "v" })
  try {
    const rows = subagentRows(sub, 6000, 80, defaultTheme).map(stripAnsi)
    expect(rows[0]).toMatch(/^ {2}`- [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] List/)
    expect(rows[1]).toMatch(/^ {5}`- [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] bash/)
    const notice = userLines(
      defaultTheme,
      {
        role: "user",
        content: [],
        display: { origin: "subagent", text: "◆ List files ✓ explorer · 6s" },
      },
      80,
    )
    expect(notice.map(stripAnsi)).toEqual(["  `- v List files · explorer · 6s"])
  } finally {
    setGlyphs()
  }
})

for (const minus of ["-", "−"]) {
  test(`diff results distinguish additions and ${minus}deletions in head and expanded rows`, () => {
    for (const detail of ["summary", "full"] as const) {
      const rows = finishedToolLines(
        defaultTheme,
        { result: () => `+1 ${minus}1` },
        {
          name: "edit",
          args: { path: "add.ts" },
          result: textResult("changed"),
        },
        detail,
        100,
      )
      expect(rows.join("\n")).toContain(defaultTheme.success("+1"))
      expect(rows.join("\n")).toContain(defaultTheme.error(`${minus}1`))
      expect(rows.join("\n")).toContain(defaultTheme.muted(" / "))
      expect(rows.map(stripAnsi).join("\n")).toContain(`+1 / ${minus}1`)
      expect(rows.map(stripAnsi).join("\n")).not.toContain("✓")
    }
  })
}
