import { expect, test } from "bun:test"
import { defaultTheme, stripAnsi } from "@amira/tui-kit"
import { historyLines } from "../src/format.ts"

test("a resumed history shows prompts, replies and one line per tool call", () => {
  const lines = historyLines(defaultTheme, [
    { role: "user", content: [{ type: "text", text: "fix it" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Looking at **it**:\n\n- one" },
        { type: "toolCall", id: "c1", name: "read", args: { path: "a.ts" } },
      ],
      model: { provider: "p", model: "m" },
    },
    { role: "toolResult", toolCallId: "c1", toolName: "read", content: [], isError: false },
  ]).map(stripAnsi)
  expect(lines).toEqual([
    "› fix it",
    "",
    "Looking at it:",
    "",
    "• one",
    "",
    "● read a.ts",
    "",
    "── resumed ──",
    "",
  ])
})

test("a resumed message with a display shows it and its note, not its content", () => {
  const lines = historyLines(defaultTheme, [
    {
      role: "user",
      content: [{ type: "text", text: 'Skill "review-pr"\n\nMany lines of instructions' }],
      display: { text: "/review-pr 123", note: "Loaded skill review-pr (120 lines)" },
    },
    { role: "user", content: [{ type: "text", text: "a" }], display: { text: "/plain" } },
    { role: "user", content: [{ type: "text", text: "own text" }], display: { text: " " } },
  ]).map(stripAnsi)
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
    "",
  ])
})
