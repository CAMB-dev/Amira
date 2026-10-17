// A deliberate oracles: warning glyph consumes its gutter gap; command error uses the marker column instead of a second gutter.
import { expect, test } from "bun:test"
import { defaultTheme, stripAnsi } from "@amira/tui-kit"
import { commandOutputLines, noticeLines, Transcript } from "../src/transcript.ts"

test("one blank line between blocks, none between the tool calls of a step or a command and its output", () => {
  const t = new Transcript()
  const out = [
    ...t.block("banner", ["Amira"]),
    ...t.block("user", ["  › hi"]),
    ...t.block("tool", ["  ├ read a  ✓ contents of a"]),
    ...t.block("tool", ["  └ read b  ✓ contents of b"]),
    ...t.block("assistant", ["  reply"]),
    ...t.block("command", ["  › /status"]),
    ...t.block("command-output", ["  └ ok"]),
    ...t.block("notice", ["• note"]),
  ]
  expect(out).toEqual([
    "Amira",
    "",
    "  › hi",
    "",
    "  ├ read a  ✓ contents of a",
    "  └ read b  ✓ contents of b",
    "",
    "  reply",
    "",
    "  › /status",
    "  └ ok",
    "",
    "• note",
  ])
})

test("a streamed block gets its gap once, however many pieces it is committed in", () => {
  const t = new Transcript()
  t.block("user", ["  › go"])
  expect(t.gapBefore("assistant")).toBe(true)
  expect(t.continue("assistant", ["  row 1"])).toEqual(["", "  row 1"])
  expect(t.gapBefore("assistant")).toBe(false)
  expect(t.continue("assistant", ["  row 2"])).toEqual(["  row 2"])
  expect(t.continue("assistant", [])).toEqual([])
  t.end()
  expect(t.continue("assistant", ["  next reply"])).toEqual(["", "  next reply"])
})

test("system notices lead with a symbol by level and indent their later lines", () => {
  const plain = (l: string[]) => l.map(stripAnsi)
  expect(plain(noticeLines(defaultTheme, "interrupted", "Interrupted."))).toEqual(["⊘ Interrupted."])
  expect(plain(noticeLines(defaultTheme, "warning", "a\nb"))).toEqual(["⚠️a", "  b"])
  expect(plain(noticeLines(defaultTheme, "success", "Compacted"))).toEqual(["✓ Compacted"])
  expect(plain(noticeLines(defaultTheme, "error", "boom"))).toEqual(["✗ boom"])
  expect(plain(noticeLines(defaultTheme, "info", "(no reply)"))).toEqual(["• (no reply)"])
  expect(plain(commandOutputLines(defaultTheme, "info", "one\ntwo"))).toEqual(["└ one", "  two"])
})

test("a command's error output is marked without colors too", () => {
  const plain = (l: string[]) => l.map(stripAnsi)
  expect(plain(commandOutputLines(defaultTheme, "error", "no such model\ntry /model"))).toEqual([
    "✗ no such model",
    "  try /model",
  ])
})

test("a row of columns in a command's output wraps under its last column", () => {
  const text = `/compact [instructions]  ${"Summarize the conversation so far to free up context ".repeat(2).trim()}`
  const rows = commandOutputLines(defaultTheme, "info", text, 60).map(stripAnsi)
  expect(rows.length).toBeGreaterThan(1)
  const col = "└ /compact [instructions]  ".length
  for (const r of rows.slice(1)) expect(r.slice(0, col).trim()).toBe("")
  for (const r of rows) expect(r.length).toBeLessThanOrEqual(60)
})

test("a last column too far in to wrap under goes under its row, indented", () => {
  const text = [
    `/tools [enable|disable <name>]     List tools; enable or disable one for this session`,
    `/verbose [collapsed|summary|full]  Show more or less of later tool output`,
  ].join("\n")
  const rows = commandOutputLines(defaultTheme, "info", text, 60).map(stripAnsi)
  expect(rows).toEqual([
    "└ /tools [enable|disable <name>]",
    "      List tools; enable or disable one for this session",
    "  /verbose [collapsed|summary|full]",
    "      Show more or less of later tool output",
  ])
})
