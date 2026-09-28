import { expect, test } from "bun:test"
import { defaultTheme, stripAnsi } from "@amira/tui-kit"
import { subagentEndLine, subagentRows, summarizeArgs, userLines } from "../src/format.ts"
import { historyLines } from "../src/history.ts"

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
    "  ⎿ 2 lines",
    "✗ grep x",
    "  ⎿ Invalid regular expression",
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
  expect(line("done")).toBe("  ⎿ ◆ US market trend ✓ explorer · 41.0s · 12.3k tok · Found it in a.ts")
  expect(line("error", "model failed")).toBe(
    "  ⎿ ◆ US market trend ✗ explorer · 41.0s · 12.3k tok · model failed",
  )
  expect(line("aborted")).toBe("  ⎿ ◆ US market trend ⊘ explorer · 41.0s · 12.3k tok · stopped")
})

test("a sub-agent's live rows: title, role, time and tokens, then its current tool cut to 40 characters", () => {
  const rows = (sub: Parameters<typeof subagentRows>[0], width = 80) =>
    subagentRows(sub, 13_500, width, defaultTheme).map(stripAnsi)
  const base = { title: "US market trend", role: "explorer", depth: 1, tokens: 4_100 }
  // Queued: no time yet, and no tool.
  expect(rows(base)).toEqual(["  ⎿ ◆ US market trend · explorer · queued"])
  expect(rows({ ...base, startedAt: 1_000 })).toEqual(["  ⎿ ◆ US market trend · explorer · 12s · 4.1k tok"])
  const busy = { ...base, startedAt: 1_000, activity: { name: "grep", summary: '"LiveRenderer"' } }
  expect(rows(busy)).toEqual([
    "  ⎿ ◆ US market trend · explorer · 12s · 4.1k tok",
    '  │   ● grep "LiveRenderer"',
  ])
  // One level deeper per nesting; a long summary is cut to 40 characters.
  const deep = { ...busy, depth: 2, activity: { name: "read", summary: "x".repeat(60) } }
  expect(rows(deep)).toEqual([
    "    ⎿ ◆ US market trend · explorer · 12s · 4.1k tok",
    `    │   ● read ${"x".repeat(39)}…`,
  ])
  // Narrow: cut to the width.
  for (const r of rows(deep, 30)) expect(Bun.stringWidth(r)).toBeLessThanOrEqual(30)
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
    "  ⎿ Loaded skill review-pr (120 lines)",
    "",
    "› /plain",
    "",
    // A blank display falls back to the content.
    "› own text",
    "",
    "── resumed ──",
  ])
})
