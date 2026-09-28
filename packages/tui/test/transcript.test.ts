import { expect, test } from "bun:test"
import { defaultTheme, stripAnsi } from "@amira/tui-kit"
import { ToolCalls } from "../src/tool-calls.ts"
import { commandOutputLines, noticeLines, Transcript } from "../src/transcript.ts"

test("one blank line between blocks, none between the tool calls of a step or a command and its output", () => {
  const t = new Transcript()
  const out = [
    ...t.block("banner", ["Amira"]),
    ...t.block("user", ["› hi"]),
    ...t.block("tool", ["● read a"]),
    ...t.block("tool", ["● read b"]),
    ...t.block("assistant", ["  reply"]),
    ...t.block("command", ["› /status"]),
    ...t.block("command-output", ["  ⎿ ok"]),
    ...t.block("notice", ["• note"]),
  ]
  expect(out).toEqual([
    "Amira",
    "",
    "› hi",
    "",
    "● read a",
    "● read b",
    "",
    "  reply",
    "",
    "› /status",
    "  ⎿ ok",
    "",
    "• note",
  ])
})

test("a streamed block gets its gap once, however many pieces it is committed in", () => {
  const t = new Transcript()
  t.block("user", ["› go"])
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
  expect(plain(noticeLines(defaultTheme, "warning", "a\nb"))).toEqual(["⚠ a", "  b"])
  expect(plain(noticeLines(defaultTheme, "success", "Compacted"))).toEqual(["✓ Compacted"])
  expect(plain(noticeLines(defaultTheme, "error", "boom"))).toEqual(["✗ boom"])
  expect(plain(noticeLines(defaultTheme, "info", "(no reply)"))).toEqual(["• (no reply)"])
  expect(plain(commandOutputLines(defaultTheme.text, defaultTheme.muted, "one\ntwo"))).toEqual([
    "  ⎿ one",
    "    two",
  ])
})

test("parallel calls are released in call order, whatever order they finish in", () => {
  const calls = new ToolCalls()
  const end = { result: { content: [] }, durationMs: 1 }
  calls.expect(["read", "grep", "edit"])
  for (const id of ["read", "grep", "edit"]) calls.start(id, id, {}, 0)
  // edit finishes first but waits; the live rows keep the call order.
  expect(calls.end("edit", end)).toEqual([])
  expect(calls.live.map((c) => [c.id, !!c.end])).toEqual([
    ["read", false],
    ["grep", false],
    ["edit", true],
  ])
  expect(calls.running).toBe(2)
  expect(calls.end("read", end).map((c) => c.id)).toEqual(["read"])
  expect(calls.end("grep", end).map((c) => c.id)).toEqual(["grep", "edit"])
  expect(calls.live).toEqual([])
})

test("a call that was never expected is placed when it starts; flush hands over what finished", () => {
  const calls = new ToolCalls()
  const end = { result: { content: [] }, durationMs: 1 }
  calls.expect(["a", "b"])
  calls.start("b", "b", {}, 0)
  calls.start("x", "x", {}, 0)
  expect(calls.end("x", end)).toEqual([])
  expect(calls.end("b", end)).toEqual([])
  // a never started (the turn was cut short): the finished ones still reach the transcript.
  expect(calls.flush().map((c) => c.id)).toEqual(["b", "x"])
  expect(calls.live).toEqual([])
})
