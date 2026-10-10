import { expect, test } from "bun:test"
import { bold, createTheme, Editor, visibleWidth } from "@amira/tui-kit"
import { activityRow } from "../src/app/activity-row.ts"
import { ReplyBlock } from "../src/blocks.ts"
import { renderToolLines } from "../src/diff-view.ts"
import { userLines } from "../src/format.ts"
import { headerLine } from "../src/header.ts"
import { InputBox } from "../src/input-box.ts"
import { exploredLine, runningToolLines } from "../src/tool-view.ts"

// Truecolor values sampled from the captured ANSI prototype: Yours, neutral dark, comfy.
const theme = createTheme({ theme: "dark", colorDepth: "truecolor", env: {}, platform: "linux" })
const ctx = { theme, color: true, rows: 40 }
const at = new Date(2026, 9, 10, 20, 19).getTime()

test("prototype details: painted band padding and bold accent prompt preserve ANSI surfaces", () => {
  const rows = userLines(theme, { role: "user", content: [{ type: "text", text: "A prompt" }] }, 100, at)
  expect(rows).toHaveLength(3)
  for (const row of rows) {
    expect(row).toContain("\x1b[48;2;32;32;32m")
    expect(visibleWidth(row)).toBe(100)
  }
  expect(rows[0]).toBe(theme.userBg!(" ".repeat(100)))
  expect(rows[2]).toBe(theme.userBg!(" ".repeat(100)))
  expect(rows[1]).toContain(bold(theme.accent("›")))
  expect(rows[1]).toContain("\x1b[38;2;120;219;226m›")
  expect(rows[1]).toContain(theme.muted("20:19"))
})

test("prototype details: warning dirty marker, quiet divider, folded glyph and running accent", () => {
  const header = headerLine(
    { cwd: "~/dev/Amira", branch: "main", dirty: true, cost: "$0.42", used: 124000, limit: 200000 },
    100,
    ctx,
  )
  expect(header).toContain("\x1b[38;2;226;179;86m*\x1b[39m")
  expect(header).toContain(theme.dim("  │  "))
  const grouped = exploredLine(
    theme,
    [
      { verb: "Read", target: "a.ts" },
      { verb: "Read", target: "a.ts" },
    ],
    100,
  )
  expect(grouped).toContain(theme.fg2("Read 2 files"))
  expect(grouped).toContain(theme.path!("(a.ts)"))
  expect(grouped).toContain(theme.muted("▸"))
  const running = runningToolLines(
    theme,
    undefined,
    { name: "bash", args: { command: "git diff --stat" }, startedAt: at },
    at,
    "⠋",
    100,
  )
  expect(running[0]).toContain(theme.accent("⠋"))
  expect(running[0]).not.toContain(theme.shimmer("⠋"))
})

test("prototype details: diff context surface and independently colored signs", () => {
  const rows = renderToolLines(
    [
      { kind: "diff-context", lineNo: 41, text: "const right = items" },
      { kind: "diff-remove", lineNo: 42, text: "const ctx = old" },
      { kind: "diff-add", lineNo: 42, text: "const ctx = next" },
    ],
    theme,
    94,
  )
  expect(rows[0]).toContain("\x1b[48;2;25;25;25m")
  expect(rows[1]).toContain("\x1b[48;2;71;20;26m")
  expect(rows[2]).toContain("\x1b[48;2;15;58;18m")
  expect(rows[1]).toContain("\x1b[38;2;229;115;122m- ")
  expect(rows[2]).toContain("\x1b[38;2;143;196;106m+ ")
  for (const row of rows) expect(visibleWidth(row)).toBe(94)
})

test("prototype details: spaced status stats, fg2 stop key and focused input palette", () => {
  const status = activityRow(
    {
      label: "responding",
      spinner: "⠋",
      stepMs: 4100,
      turnMs: 80000,
      tokens: 12400,
      rate: 186,
      stop: "esc stop",
      animationMs: 0,
    },
    100,
    ctx,
  )
  expect(status).toContain(`${theme.muted("1m20s")}  ${theme.dim("⇣")}`)
  expect(status).toContain(theme.dim("  ·  "))
  expect(status).toContain(bold(theme.fg2("esc")) + theme.muted(" stop"))
  const input = new InputBox(new Editor({ prompt: "› ", placeholder: "Message Amira" }), () => [
    { id: "model", text: "claude-opus-5-5 (high) · ask", align: "right", tone: "accent", priority: 40 },
  ]).render(100, ctx)
  expect(input[0]).toContain("\x1b[38;2;86;86;86m")
  expect(input[1]).toContain(bold(theme.accent("› ")))
  expect(input[2]).toContain(theme.accent("claude-opus-5-5"))
  expect(input[2]).toContain(theme.muted(" (high)"))
  expect(input[2]).toContain(theme.muted("ask"))
  for (const row of input) expect(visibleWidth(row)).toBe(100)
})

test("prototype details: sky heading and quiet list markers retain semantic Markdown", () => {
  const rows = new ReplyBlock(
    "# Status bar layout\n\n- **header:** branch and path left\n- colour shifts at 50 / 75 / 95%",
    false,
    false,
  ).lines({
    theme,
    width: 100,
    now: at,
    spinner: "⠋",
    detail: "summary",
    presenters: undefined,
    hyperlinks: false,
    nodes: new Map(),
  })
  expect(rows[0]).toContain("\x1b[38;2;111;179;232mStatus bar layout")
  const list = rows.filter((row) => row.includes("•"))
  expect(list).toHaveLength(2)
  for (const row of list) expect(row).toContain("\x1b[38;2;114;114;114m•")
})
