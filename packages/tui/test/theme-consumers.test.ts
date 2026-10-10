import { expect, spyOn, test } from "bun:test"
import { textResult } from "@amira/api"
import { defaultTheme, Editor, fg256, italic, stripAnsi, type Theme, visibleWidth } from "@amira/tui-kit"
import { renderToolLines } from "../src/diff-view.ts"
import { reasoningLines } from "../src/format.ts"
import { InputBox } from "../src/input-box.ts"
import { type StatusEntry, statusLine } from "../src/status-bar.ts"
import { finishedToolLines, runningToolLines } from "../src/tool-view.ts"
import { UiRuntime } from "../src/ui-runtime/runtime.ts"
import { renderViewLines } from "../src/view-lines.ts"

const theme = {
  ...defaultTheme,
  path: fg256(101),
  command: fg256(102),
  fg2: fg256(103),
  dim: fg256(104),
  thinking: fg256(105),
  borderFocused: fg256(106),
  shimmer: fg256(107),
}
const context = { theme, color: true, rows: 24 }

test("tool summaries use path and command tokens without changing their text", () => {
  for (const [args, style, summary] of [
    [{ path: "src/file.ts" }, theme.path, "src/file.ts"],
    [{ command: "node --version" }, theme.command, "node --version"],
  ] as const) {
    const call = { name: "tool", args, result: textResult("done") }
    const rows = finishedToolLines(theme, undefined, call, "collapsed", 80)
    expect(rows[0]).toContain(style(summary))
    expect(stripAnsi(rows[0]!)).toBe(`  ├ tool ${summary}  ✓ done`)
    expect(rows[0]).toContain(theme.muted("├"))
    expect(rows[0]).toContain(theme.fg2("tool"))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain(theme.success("✓ done"))
    const rejected = finishedToolLines(theme, undefined, { ...call, rejected: "blocked" }, "collapsed", 80)
    expect(rejected[0]).toContain(theme.muted(summary))
    expect(rejected[0]).toContain(theme.muted("tool"))
    expect(rejected[0]).not.toContain(style(summary))
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toContain(theme.muted("⊘ done"))
    const failed = finishedToolLines(
      theme,
      undefined,
      { ...call, result: textResult("failed", true) },
      "collapsed",
      80,
    )
    expect(failed[0]).toContain(theme.fg2("tool"))
    expect(failed[0]).toContain(style(summary))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain(theme.error("✗ failed"))
    const expanded = finishedToolLines(theme, undefined, call, "full", 80)
    expect(expanded[1]).toBe(`  ${theme.muted("│")}  ${theme.success("✓ done")}${theme.muted("")}`)
    const running = runningToolLines(theme, undefined, { ...call, startedAt: 0 }, 1000, "⠋", 80)
    expect(running[0]).toContain(style(summary))
    expect(running[0]).toContain(theme.accent("⠋"))
    expect(visibleWidth(running[0]!)).toBe(80)
  }
})

test("file headers and program output use path and secondary foreground tokens", () => {
  const rows = renderToolLines(
    [
      { kind: "muted", text: "--- src/file.ts" },
      { kind: "code", text: "const value = 1" },
      { kind: "muted", text: "… 2 more lines" },
    ],
    theme,
    80,
  )
  expect(rows).toEqual([
    theme.muted("") + theme.path("--- src/file.ts"),
    theme.muted("") + theme.fg2("const value = 1"),
    theme.muted("") + theme.muted("… 2 more lines"),
  ])
})

test("reasoning labels use thinking while expanded text retains muted italics", () => {
  const rows = reasoningLines(theme, "a thought", { thinking: true, expanded: true }, 80)
  expect(rows[0]).toBe(`  ${theme.thinking("∴")} ${theme.thinking("Thinking")}`)
  expect(rows[1]).toContain(theme.muted(italic("a thought")))
  expect(rows.map(stripAnsi)).toEqual(["  ∴ Thinking", "    a thought"])
})

test("the editor border follows focus without changing the frame", () => {
  const editor = new Editor({ prompt: "› " })
  const box = new InputBox(editor)
  const focused = box.render(30, context)
  expect(focused[0]).toBe(theme.borderFocused(`╭${"─".repeat(28)}╮`))
  expect(focused.every((line) => visibleWidth(line) === 30)).toBe(true)
  editor.focused = false
  const unfocused = box.render(30, context)
  expect(unfocused[0]).toBe(theme.border(`╭${"─".repeat(28)}╮`))
  expect(unfocused.map(stripAnsi)).toEqual(focused.map(stripAnsi))
})

test("input boxes reuse the focused-border theme across renders and boxes", () => {
  const editor = new Editor({ prompt: "› " })
  const seen: Theme[] = []
  const render = spyOn(editor, "render").mockImplementation((_width, ctx) => {
    seen.push(ctx.theme)
    return [""]
  })
  try {
    const box = new InputBox(editor)
    box.render(30, context)
    box.render(40, { ...context, rows: 30 })
    new InputBox(editor).render(30, context)
    expect(seen[1]).toBe(seen[0]!)
    expect(seen[2]).toBe(seen[0]!)
    expect(seen[0]!.border).toBe(theme.borderFocused)
    expect(theme.border).toBe(defaultTheme.border)
    editor.focused = false
    box.render(30, context)
    expect(seen[3]).toBe(theme)
    editor.focused = true
    const other = { ...theme, borderFocused: theme.path }
    box.render(30, { ...context, theme: other })
    expect(seen[4]).not.toBe(seen[0]!)
    expect(seen[4]!.border).toBe(other.borderFocused)
    box.render(30, context)
    expect(seen[5]).toBe(seen[0]!)
  } finally {
    render.mockRestore()
  }
})

test("focused widget borders and separators use their distinct tokens", () => {
  const runtime = new UiRuntime(() => {})
  const rows = runtime.render(
    {
      type: "box",
      tone: "focus",
      child: {
        type: "column",
        divider: true,
        children: [
          { size: 1, node: { type: "text", lines: [{ kind: "text", text: "one" }] } },
          { size: 1, node: { type: "text", lines: [{ kind: "text", text: "two" }] } },
        ],
      },
    },
    30,
    5,
    theme,
    (lines, width) => renderViewLines(lines, theme, width),
  )
  expect(rows[0]).toContain(theme.borderFocused("┏"))
  expect(rows[2]).toContain(theme.dim("─".repeat(28)))
  expect(rows.every((line) => visibleWidth(line) === 30)).toBe(true)
  runtime.dispose()
})

test("status separators use dim without recoloring status text", () => {
  const entries: StatusEntry[] = ["one", "two"].map((text) => ({
    id: text,
    text,
    tone: "muted",
    align: "left",
    priority: 1,
  }))
  expect(statusLine(entries, 80, context)).toEqual([
    theme.muted("one") + theme.dim(" · ") + theme.muted("two"),
  ])
})
