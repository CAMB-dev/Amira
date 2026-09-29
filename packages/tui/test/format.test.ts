import { expect, test } from "bun:test"
import type { EventEnvelope } from "@amira/api"
import { defaultTheme, stripAnsi, surfaceTheme, visibleWidth } from "@amira/tui-kit"
import {
  bandRows,
  commandEchoLines,
  isLastSibling,
  subagentEndLine,
  subagentRows,
  summarizeArgs,
  userLines,
} from "../src/format.ts"
import { historyLines } from "../src/history.ts"
import { isActive, type SubagentNode, stateNode } from "../src/subagents.ts"

const plain = (lines: string[]) => lines.map(stripAnsi)

test("summarizeArgs leads with the argument that matters and labels the others", () => {
  expect(summarizeArgs({ command: "bun  test\n--watch", timeout: 5, obj: { a: 1 } })).toBe(
    "bun test --watch · timeout=5",
  )
  // The path leads even when it is not the first argument, and long values are cut.
  expect(summarizeArgs({ old_string: "x".repeat(40), path: "src/a.ts" })).toBe(
    `src/a.ts · old_string=${"x".repeat(23)}…`,
  )
  expect(summarizeArgs({ x: "a".repeat(200) }, 10)).toBe(`${"a".repeat(9)}…`)
  expect(summarizeArgs({ n: 3 })).toBe("n=3")
  expect(summarizeArgs({})).toBe("")
})

test("the user's message wraps under its prompt symbol, not to the first column", () => {
  const message = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "one two three four five six\nseven" }],
  }
  expect(plain(userLines(defaultTheme, message, 16))).toEqual([
    "› one two three",
    "  four five six",
    "  seven",
  ])
})

const banded = { ...defaultTheme, ...surfaceTheme("dark") }
const BAND = "\x1b[48;5;236m"

/** Each row is on the band from the first cell to exactly the last one. */
function expectBand(rows: string[], width: number) {
  for (const r of rows) {
    expect({ r, start: r.startsWith(BAND), end: r.endsWith("\x1b[49m"), w: visibleWidth(r) }).toEqual({
      r,
      start: true,
      end: true,
      w: width,
    })
    // The band is not ended early: a nested style closes its color only.
    expect(r.slice(BAND.length, -"\x1b[49m".length)).not.toContain("\x1b[49m")
  }
}

test("the user's message is on a band the width of the screen, with a row of it above and below", () => {
  const message = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "帮我看看这个测试为什么挂了" }],
  }
  const rows = userLines(banded, message, 34)
  expectBand(rows, 34)
  expect(plain(rows).map((r) => r.trimEnd())).toEqual(["", "› 帮我看看这个测试为什么挂了", ""])
  // The prompt symbol in the accent color, the text in the normal one.
  expect(rows[1]).toBe(
    `${BAND}${defaultTheme.accent("›")} 帮我看看这个测试为什么挂了${" ".repeat(6)}\x1b[49m`,
  )
})

test("wrapped rows, wide characters and the note line stay on the band, which never spills", () => {
  const message = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "x" }],
    display: { text: "/review 看看这个很长的测试名称 🧪🧪 and more words here", note: "Loaded skill review" },
  }
  for (const width of [12, 13, 20, 31]) {
    const rows = userLines(banded, message, width)
    expectBand(rows, width)
    const text = plain(rows).map((r) => r.trimEnd())
    expect(text[0]).toBe("")
    expect(text.at(-1)).toBe("")
    expect(text.at(-2)).toBe("  └ Loaded skill review".slice(0, width).trimEnd())
    // Every word is there, under the prompt symbol.
    expect(text.slice(1, -2).join(" ").replace(/\s+/g, " ")).toContain("and more words here")
  }
  // Narrower than the text can wrap to: cut to the width, not wider.
  expectBand(userLines(banded, message, 6), 6)
})

test("without the band token (NO_COLOR, or a theme without it) the message is as before", () => {
  const message = { role: "user" as const, content: [{ type: "text" as const, text: "hi there" }] }
  expect(userLines(defaultTheme, message, 20)).toEqual([`${defaultTheme.accent("›")} hi there`])
  // With no width to fill, as for notices waiting to be sent, there is no band either.
  expect(plain(userLines(banded, message))).toEqual(["› hi there"])
})

test("a command's echo is on the band too, muted", () => {
  const rows = commandEchoLines(banded, "/status", 20)
  expectBand(rows, 20)
  expect(rows[1]).toBe(`${BAND}${defaultTheme.muted("› /status")}${" ".repeat(11)}\x1b[49m`)
  expect(commandEchoLines(defaultTheme, "/status", 20)).toEqual([defaultTheme.muted("› /status")])
  expect(bandRows(["abc"], 2, banded.userBg).map(visibleWidth)).toEqual([2, 2, 2])
})

test("a wrapped echo keeps the band after the reset that ends its style on a row", () => {
  const rows = commandEchoLines(banded, `/model ${"x".repeat(30)}`, 20)
  expectBand(rows, 20)
  expect(rows.length).toBeGreaterThan(3)
  // Its rows after the first hang under the command, past "› ".
  expect(rows.slice(2, -1).every((r) => stripAnsi(r).startsWith("  x"))).toBe(true)
  for (const r of rows) {
    const resets = r.split("\x1b[0m").slice(1)
    for (const after of resets) expect(after.startsWith(BAND)).toBe(true)
  }
})

test("with an unknown background, muted text on the band is drawn as normal text", () => {
  const unknown = { ...defaultTheme, ...surfaceTheme(undefined) }
  const rows = commandEchoLines(unknown, "/status", 20)
  expect(rows[1]).toBe(`\x1b[48;5;242m› /status${" ".repeat(11)}\x1b[49m`)
})

test("a resumed history uses the transcript's blocks, the tool presenters and a named separator", () => {
  const lines = historyLines(
    defaultTheme,
    [
      { role: "user", content: [{ type: "text", text: "fix it" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "toolCall", id: "c1", name: "read", args: { path: "a.ts" } },
          { type: "toolCall", id: "c2", name: "grep", args: { pattern: "x" } },
        ],
        model: { provider: "p", model: "m" },
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "1\ta\n2\tb" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "grep",
        content: [{ type: "text", text: "Invalid regular expression" }],
        isError: true,
      },
      { role: "assistant", content: [{ type: "text", text: "Done." }], model: { provider: "p", model: "m" } },
    ],
    {
      width: 60,
      presenters: { get: (name) => (name === "read" ? { result: () => "2 lines" } : undefined) },
      session: { id: "s_42", updatedAt: new Date(2026, 8, 29, 14, 5).getTime() },
    },
  )
  expect(plain(lines)).toEqual([
    "› fix it",
    "",
    "  Looking.",
    "",
    "● read a.ts",
    "  └ 2 lines",
    "✗ grep x",
    "  └ Invalid regular expression",
    "",
    "  Done.",
    "",
    "── resumed s_42 · 2026-09-29 14:05 ──",
  ])
})

test("a resumed reply renders as Markdown inside the assistant's gutter", () => {
  const lines = historyLines(
    defaultTheme,
    [
      { role: "user", content: [{ type: "text", text: "fix it" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking at **it**:\n\n- one\n\n```ts\nconst a = 1\n```" },
          { type: "toolCall", id: "c1", name: "read", args: { path: "a.ts" } },
        ],
        model: { provider: "p", model: "m" },
      },
      { role: "toolResult", toolCallId: "c1", toolName: "read", content: [], isError: false },
    ],
    { width: 30 },
  )
  const rows = plain(lines)
  expect(rows.slice(0, 6)).toEqual(["› fix it", "", "  Looking at it:", "", "  • one", ""])
  // The code block is framed within the width less the gutter, every row indented.
  const code = rows.slice(6, rows.indexOf("", 6))
  expect(code[0]).toStartWith("  ╭─ ts")
  expect(code.some((r) => r.includes("const a = 1"))).toBe(true)
  for (const r of code) {
    expect(r).toStartWith("  ")
    expect(Bun.stringWidth(r)).toBeLessThanOrEqual(30)
  }
  expect(rows.at(-1)).toBe("── resumed ──")
  expect(rows).toContain("● read a.ts")
})

test("a sub-agent's end line says how it ended, its time, tokens and the start of its answer", () => {
  const sub = {
    title: "US market trend",
    role: "explorer",
    depth: 1,
    tokens: 12_345,
    lastText: "Found it\nin a.ts",
  }
  const line = (status: "done" | "error" | "aborted", error?: string) =>
    stripAnsi(
      subagentEndLine(
        sub,
        { status, durationMs: 41_000, tokens: sub.tokens, ...(error ? { error } : {}) },
        80,
        defaultTheme,
      ),
    )
  expect(line("done")).toBe("  └ ◆ US market trend ✓ explorer · 41.0s · 12k tok · Found it in a.ts")
  expect(line("error", "model failed")).toBe(
    "  └ ◆ US market trend ✗ explorer · 41.0s · 12k tok · model failed",
  )
  expect(line("aborted")).toBe("  └ ◆ US market trend ⊘ explorer · 41.0s · 12k tok · stopped")
})

test("a sub-agent's live rows: title, role, time and tokens, then its current tool cut to 40 characters", () => {
  const rows = (sub: Parameters<typeof subagentRows>[0], width = 80) =>
    subagentRows(sub, 13_500, width, defaultTheme).map(stripAnsi)
  const base = { title: "US market trend", role: "explorer", depth: 1, tokens: 4_100 }
  // Queued: no time yet, and no tool.
  expect(rows(base)).toEqual(["  └ ◆ US market trend · explorer · queued"])
  expect(rows({ ...base, startedAt: 1_000 })).toEqual(["  └ ◆ US market trend · explorer · 12s · 4.1k tok"])
  const busy = { ...base, startedAt: 1_000, activity: { name: "grep", summary: '"LiveRenderer"' } }
  expect(rows(busy)).toEqual([
    "  └ ◆ US market trend · explorer · 12s · 4.1k tok",
    '    └ ● grep "LiveRenderer"',
  ])
  // With a row of the same tree after it: "├", and "│" carries the tree past its tool row.
  expect(subagentRows(busy, 13_500, 80, defaultTheme, false).map(stripAnsi)).toEqual([
    "  ├ ◆ US market trend · explorer · 12s · 4.1k tok",
    '  │ └ ● grep "LiveRenderer"',
  ])
  // One level deeper per nesting; a long summary is cut to 40 characters.
  const deep = { ...busy, depth: 2, activity: { name: "read", summary: "x".repeat(60) } }
  expect(rows(deep)).toEqual([
    "    └ ◆ US market trend · explorer · 12s · 4.1k tok",
    `      └ ● read ${"x".repeat(39)}…`,
  ])
  // Narrow: cut to the width.
  for (const r of rows(deep, 30)) expect(Bun.stringWidth(r)).toBeLessThanOrEqual(30)
  // A persistent one between turns says so, without a clock or a tool.
  expect(rows({ ...busy, idle: true })).toEqual(["  └ ◆ US market trend · explorer · idle · 4.1k tok"])
})

test("subagent.state: an idle persistent sub-agent is not active, and working again is", () => {
  const node: SubagentNode = {
    id: "c1",
    parent: "main",
    title: "writer",
    role: "agent",
    depth: 1,
    tokens: 0,
    startedAt: 1,
    activity: { name: "read", summary: "a.ts" },
  }
  const state = (s: "idle" | "working", turns: number) =>
    ({
      type: "subagent.state",
      sessionId: "main",
      ts: 5,
      data: { childSessionId: "c1", state: s, turns },
    }) as EventEnvelope<"subagent.state">
  stateNode(node, state("idle", 1))
  expect(isActive(node)).toBe(false)
  expect(node.activity).toBeUndefined()
  stateNode(node, state("working", 2))
  expect(isActive(node)).toBe(true)
})

test("a resumed message with a display shows it and its note, not its content", () => {
  const lines = historyLines(
    defaultTheme,
    [
      {
        role: "user",
        content: [{ type: "text", text: 'Skill "review-pr"\n\nMany lines of instructions' }],
        display: { text: "/review-pr 123", note: "Loaded skill review-pr (120 lines)" },
      },
      { role: "user", content: [{ type: "text", text: "a" }], display: { text: "/plain" } },
      { role: "user", content: [{ type: "text", text: "own text" }], display: { text: " " } },
    ],
    { width: 60 },
  ).map(stripAnsi)
  expect(lines).toEqual([
    "› /review-pr 123",
    "  └ Loaded skill review-pr (120 lines)",
    "",
    "› /plain",
    "",
    // A blank display falls back to the content.
    "› own text",
    "",
    "── resumed ──",
  ])
})

test("isLastSibling: a row closes its level when no later row sits at its depth before the level ends", () => {
  const list = [{ depth: 1 }, { depth: 2 }, { depth: 2 }, { depth: 1 }, { depth: 2 }]
  expect(list.map((_, i) => isLastSibling(list, i))).toEqual([false, false, true, true, true])
})
