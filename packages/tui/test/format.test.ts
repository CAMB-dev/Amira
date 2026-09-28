import { expect, test } from "bun:test"
import { defaultTheme, stripAnsi } from "@amira/tui-kit"
import { subagentEndLine, summarizeArgs } from "../src/format.ts"
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

test("a sub-agent's end line says how it ended, its time, tokens and the start of its answer", () => {
  const sub = { role: "explorer", task: "t", depth: 1, tokens: 12_345, lastText: "Found it\nin a.ts" }
  const line = (status: "done" | "error" | "aborted", error?: string) =>
    stripAnsi(
      subagentEndLine(
        sub,
        { status, durationMs: 41_000, tokens: sub.tokens, ...(error ? { error } : {}) },
        80,
        defaultTheme,
      ),
    )
  expect(line("done")).toBe("◆ explorer ✓ 41.0s · 12.3k tok · Found it in a.ts")
  expect(line("error", "model failed")).toBe("◆ explorer ✗ 41.0s · 12.3k tok · model failed")
  expect(line("aborted")).toBe("◆ explorer ⊘ 41.0s · 12.3k tok · stopped")
})
