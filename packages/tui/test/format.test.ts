import { expect, test } from "bun:test"
import { defaultTheme, stripAnsi } from "@amira/tui-kit"
import { historyLines } from "../src/format.ts"

test("a resumed history shows prompts, replies and one line per tool call", () => {
  const lines = historyLines(defaultTheme, [
    { role: "user", content: [{ type: "text", text: "fix it" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Looking." },
        { type: "toolCall", id: "c1", name: "read", args: { path: "a.ts" } },
      ],
      model: { provider: "p", model: "m" },
    },
    { role: "toolResult", toolCallId: "c1", toolName: "read", content: [], isError: false },
  ]).map(stripAnsi)
  expect(lines).toEqual(["› fix it", "", "Looking.", "", "● read a.ts", "", "── resumed ──", ""])
})
