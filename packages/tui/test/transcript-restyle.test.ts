import { expect, test } from "bun:test"
import { type AssistantMessage, type Message, textResult, type UserMessage } from "@amira/api"
import { defaultTheme, pendingBlock, stripAnsi, surfaceTheme, visibleWidth } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { type BlockEnv, LinesBlock, ReasoningBlock, ReplyBlock, ToolBlock, userBlock } from "../src/blocks.ts"
import {
  localClock,
  messageTimestamp,
  reasoningLines,
  rememberMessageTime,
  timestampRoom,
  timestampRow,
  userLines,
} from "../src/format.ts"
import { historyBlocks } from "../src/fullscreen/history-blocks.ts"
import { setGlyphs } from "../src/glyphs.ts"
import { historyLines } from "../src/history.ts"
import { Transcript } from "../src/transcript.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"
import { setup } from "./app-harness.ts"

const at = new Date(2026, 9, 10, 20, 9).getTime()
const banded = { ...defaultTheme, ...surfaceTheme("dark") }
const env = (width = 80): BlockEnv => ({
  theme: plain.theme,
  width,
  now: at,
  spinner: "*",
  detail: "summary",
  reasoningExpandKey: "Ctrl+O",
  presenters: undefined,
  hyperlinks: false,
  nodes: new Map(),
})
const user: UserMessage & { timestamp: number } = {
  role: "user",
  content: [{ type: "text", text: "Hello there.\nNext line." }],
  timestamp: at,
}
const assistant: AssistantMessage & { timestamp: number } = {
  role: "assistant",
  model: { provider: "mock", model: "m" },
  content: [
    { type: "thinking", text: "Consider the answer." },
    { type: "text", text: "First paragraph.\n\nSecond paragraph." },
  ],
  timestamp: at,
}

test("clocks are local, zero-padded and fixed to 24-hour time", () => {
  expect(localClock(at)).toBe("20:09")
  expect(localClock(new Date(2026, 9, 10, 0, 4).getTime())).toBe("00:04")
  expect(messageTimestamp(user)).toBe(at)
  expect(messageTimestamp({ timestamp: 0 })).toBe(0)
  for (const message of [{}, { timestamp: "20:09" }, { timestamp: Number.NaN }])
    expect(messageTimestamp(message)).toBeUndefined()
})

test("the user band spans every cell with an inset accent prompt and one first-line clock", () => {
  const lines = userLines(banded, user, 40)
  const rows = lines.map(stripAnsi)
  expect(rows).toHaveLength(2)
  expect(rows[0]).toStartWith("  › Hello there.")
  expect(rows[0]).toEndWith("20:09  ")
  expect(rows[1]?.trimEnd()).toBe("    Next line.")
  expect(lines[0]).toContain(banded.accent("›"))
  expect(lines[0]).toContain(banded.muted("20:09"))
  expect(rows.filter((r) => r.includes("20:09"))).toHaveLength(1)
  for (const line of lines) expect(visibleWidth(line)).toBe(40)
})

test("narrow bands omit clocks rather than collide with or lose the prompt text", () => {
  const message = { ...user, content: [{ type: "text" as const, text: "abcdef" }] }
  for (const width of [10, 12, 15]) {
    const rows = userLines(banded, message, width).map(stripAnsi)
    expect(rows.join("")).not.toContain("20:09")
    expect(rows.map((r) => r.slice(4).trim()).join("")).toBe("abcdef")
    expect(rows.every((r) => visibleWidth(r) === width)).toBe(true)
  }
})

test("thinking uses its semantic token and only an actionable gray disclosure hint, never a clock", () => {
  const rows = reasoningLines(banded, "A thought.", { durationMs: 65_000, expandKey: "Ctrl+O" }, 80)
  expect(stripAnsi(rows[0]!)).toBe("  ∴ Thought for 65s  Ctrl+O to expand")
  expect(rows[0]).toContain(banded.thinking!("Thought for 65s"))
  expect(rows[0]).toContain(banded.muted("Ctrl+O to expand"))
  const expanded = reasoningLines(banded, "A thought.", { expanded: true, expandKey: "Ctrl+O" }, 80)
  expect(expanded.join("")).not.toContain("to expand")
  expect(stripAnsi(expanded[1]!)).toBe("    A thought.")
  const redacted = reasoningLines(banded, "", { expandKey: "Ctrl+O" }, 80)
  expect(redacted.join("")).not.toContain("to expand")
  expect(reasoningLines(banded, "A thought.", {}, 80).map(stripAnsi)).toEqual(["  ∴ Thought"])
})

test("manually folded thinking never advertises a global key that leaves it folded", () => {
  const thought = new ReasoningBlock("A thought.", undefined)
  const e = env()
  expect(thought.lines(e)[0]).toContain("Ctrl+O to expand")
  expect(thought.lines({ ...e, detail: "collapsed" })[0]).not.toContain("to expand")
  expect(thought.lines({ ...e, reasoningExpandKey: undefined })[0]).not.toContain("to expand")
  thought.expanded = false
  expect(thought.lines(e)[0]).not.toContain("to expand")
  expect(thought.lines({ ...e, detail: "full" })).toEqual(["  ∴ Thought"])
  thought.toggleFold(e)
  expect(thought.lines(e).map(stripAnsi)).toContain("    A thought.")
  expect(thought.printLines(e)[0]).not.toContain("to expand")
})

test("live thinking invalidates full-detail text and finishes with its duration but no clock", () => {
  const pane = new TranscriptPane()
  const thought = new ReasoningBlock("", undefined, at, true)
  const e = { ...env(), detail: "full" as const }
  pane.add(thought)
  thought.append("First")
  expect(pane.plain(thought, e)).toContain("    First")
  thought.append(" second")
  expect(pane.plain(thought, e)).toContain("    First second")
  thought.finish(at + 4200)
  expect(pane.plain(thought, e)[0]).toStartWith("  ∴ Thought for 4.2s")
  expect(pane.plain(thought, e)[0]).toBe("  ∴ Thought for 4.2s")
})

test("resumed inline and fullscreen transcripts use stored clocks, and never synthesize old ones", () => {
  const render = (messages: Message[]) => {
    const e = env()
    const blocks = historyBlocks(messages, () => e, {
      hyperlinks: false,
      noticeBlock: () => {
        throw new Error("unexpected notice")
      },
      sessionId: () => "s",
      terminal: { columns: e.width },
    })
    return [
      historyLines(e.theme, messages, { width: e.width }).map(stripAnsi),
      blocks.flatMap((b) => b.lines(e)).map(stripAnsi),
    ]
  }
  for (const [i, rows] of render([user, assistant]).entries()) {
    expect(rows.filter((r) => r.endsWith("20:09  "))).toHaveLength(2)
    expect(rows).toContain(i === 0 ? "  ∴ Thought" : "  ∴ Thought  Ctrl+O to expand")
    expect(rows.some((r) => r.trim() === "Second paragraph.")).toBe(true)
  }
  const { timestamp: _userTime, ...oldUser } = user
  const { timestamp: _replyTime, ...oldAssistant } = assistant
  for (const [i, rows] of render([oldUser, oldAssistant]).entries()) {
    expect(rows.join("\n")).not.toMatch(/\d{2}:\d{2}/)
    expect(rows).toContain(i === 0 ? "  ∴ Thought" : "  ∴ Thought  Ctrl+O to expand")
  }
})

test("the reply clock is on its first line only, and copies of whole rows exclude clocks", () => {
  const reply = new ReplyBlock("First paragraph.\n\nSecond paragraph.", false, false, at)
  const e = env(40)
  const lines = reply.lines(e)
  const rows = lines.map(stripAnsi)
  expect(rows[0]).toStartWith("  First paragraph.")
  expect(rows[0]).toEndWith("20:09  ")
  expect(rows.filter((r) => r.includes("20:09"))).toHaveLength(1)
  expect(reply.printLines(e).map(stripAnsi)).toEqual(rows)
  expect(reply.copyRows(rows, lines)[0]?.exact).toBe("First paragraph.")
  const block = userBlock(user)
  const userRows = block.lines(e).map(stripAnsi)
  expect(block.copyRows(userRows)[0]?.exact).toBe("Hello there.")
})

test("timestamp space belongs to just the first rendered row in live, printed and resumed replies", () => {
  const text = `${"x".repeat(65)}\n\n\`\`\`txt\n${"z".repeat(26)}\n\`\`\``
  const width = 30
  const message: AssistantMessage & { timestamp: number } = {
    ...assistant,
    content: [{ type: "text", text }],
  }
  for (const streaming of [false, true]) {
    const reply = new ReplyBlock(text, streaming, false, at)
    for (const lines of [reply.lines(env(width)), reply.printLines(env(width))]) {
      const rows = lines.map(stripAnsi)
      expect(rows[0]).toStartWith(`  ${"x".repeat(19)}`)
      expect(rows[1]).toBe(`  ${"x".repeat(28)}`)
      expect(rows).toContain(`  │ ${"z".repeat(25)}│`)
      expect(rows).toContain(`  │ z${" ".repeat(24)}│`)
    }
  }
  const resumed = historyLines(plain.theme, [message], { width }).map(stripAnsi)
  expect(resumed[3]).toBe(`  ${"x".repeat(28)}`)
  expect(resumed).toContain(`  │ ${"z".repeat(25)}│`)
  expect(resumed).toContain(`  │ z${" ".repeat(24)}│`)
  const userRows = userLines(
    plain.theme,
    { ...user, content: [{ type: "text", text: "x".repeat(69) }] },
    width,
  )
  expect(userRows[1]).toBe(`    ${"x".repeat(26)}`)
})

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: live reply continuation and code/table rows use full available width`, async () => {
    const text =
      "x".repeat(65) +
      "\n\n```txt\n" +
      "z".repeat(26) +
      "\n```\n\n| title | second |\n| --- | --- |\n| abcdefghij | klmnop |"
    const app = await setup([{ text }], { cols: 30, rows: 40, settings: { mode } })
    try {
      app.terminal.send("go\r")
      await app.idle()
      const rows = app.all().split("\n")
      expect(rows.some((r) => new RegExp(`^  ${"x".repeat(19)}  \\d{2}:\\d{2}$`).test(r.trimEnd()))).toBe(
        true,
      )
      expect(rows.map((r) => r.trimEnd())).toContain(`  ${"x".repeat(28)}`)
      expect(rows).toContain(`  │ ${"z".repeat(25)}│`)
      expect(rows).toContain(`  │ z${" ".repeat(24)}│`)
      expect(rows.map((r) => r.trimEnd())).toContain("  abcdefghij │ klmnop")
    } finally {
      app.terminal.send("\x03")
      await app.exited
    }
  })
}

test("banded real blocks use exactly one transcript gap in inline and fullscreen", () => {
  const e = { ...env(40), theme: banded }
  const blocks = [userBlock(user), new ReplyBlock("Done.", false, false), userBlock(user)]
  const t = new Transcript()
  const inline = blocks.flatMap((block) => t.block(block.kind, block.lines(e))).map(stripAnsi)
  const pane = new TranscriptPane()
  for (const block of blocks) pane.add(block)
  const fullscreen = pane.render(e, 7).map(stripAnsi)
  const expected = [
    `  › Hello there.${" ".repeat(17)}20:09  `,
    `    Next line.${" ".repeat(26)}`,
    "",
    "  Done.",
    "",
    `  › Hello there.${" ".repeat(17)}20:09  `,
    `    Next line.${" ".repeat(26)}`,
  ]
  expect(inline).toEqual(expected)
  expect(fullscreen).toEqual(expected)
})

test("copy trimming uses actual decoration, not content that happens to end in a clock", () => {
  const clockAt = new Date(2026, 9, 10, 20, 19).getTime()
  const e = { ...env(11), theme: { ...plain.theme, userBg: (s: string) => s } }
  for (const timestamp of [undefined, clockAt]) {
    const block = userBlock({ role: "user", content: [{ type: "text", text: "20:19" }] }, timestamp)
    const lines = block.lines(e)
    expect(block.copyRows(lines.map(stripAnsi), lines)[0]).toEqual({ from: 4 })
    const reply = new ReplyBlock("20:19  ", false, false, timestamp)
    const rows = reply.lines(e)
    expect(reply.copyRows(rows.map(stripAnsi), rows)[0]).toEqual({ from: 2 })
  }
  const block = userBlock({ role: "user", content: [{ type: "text", text: "界界 20:19" }] }, clockAt)
  const lines = block.lines({ ...e, width: 40 })
  expect(block.copyRows(lines.map(stripAnsi), lines)[0]).toEqual({ from: 4, to: 14, exact: "界界 20:19" })
  const reply = new ReplyBlock("界界 20:19", false, false, clockAt)
  const rows = reply.lines({ ...e, width: 40 })
  expect(reply.copyRows(rows.map(stripAnsi), rows)[0]).toEqual({ from: 2, to: 12, exact: "界界 20:19" })
})

test("partial selections stop at actual timestamp metadata and respect wide display cells", () => {
  const block = userBlock({ role: "user", content: [{ type: "text", text: "界界 20:19" }] }, at)
  const pane = new TranscriptPane()
  pane.add(block)
  pane.render({ ...env(40), theme: banded }, 1)
  const select = (from: number, to: number) => {
    pane.selectText({ block, line: 0, col: from }, { block, line: 0, col: to })
    return pane.selectedText()
  }
  expect(select(5, 7)).toBe("界界")
  expect(select(9, 39)).toBe("20:19")
  expect(select(33, 39)).toBe("")
  expect(select(0, 39)).toBe("界界 20:19")
})

test("timestamp decoration preserves pending extension markers and oversized extension rows", () => {
  const marker = `  ${pendingBlock(Promise.resolve(["diagram"]), ["loading"])}`
  expect(timestampRow(marker, defaultTheme, 80, at)).toBe(marker)
  const extension = "x".repeat(100)
  expect(timestampRow(extension, defaultTheme, 80, at)).toBe(extension)
  expect(timestampRoom(80, undefined)).toBe(80)
  expect(timestampRoom(80, at)).toBe(71)
})

test("transcript and pane keep one blank between blocks and none between adjacent tool rows", () => {
  const t = new Transcript()
  expect(t.block("user", ["  › prompt"])).toEqual(["  › prompt"])
  expect(t.block("tool", ["  ├ Read a.ts"])).toEqual(["", "  ├ Read a.ts"])
  expect(t.block("assistant", [])).toEqual([])
  expect(t.block("tool", ["  └ Read b.ts"])).toEqual(["  └ Read b.ts"])
  expect(t.block("assistant", ["  Done."])).toEqual(["", "  Done."])
  const pane = new TranscriptPane()
  pane.add(new LinesBlock("user", () => ["  › prompt"]))
  pane.add(new LinesBlock("tool", () => ["  ├ Read a.ts"]))
  pane.add(new LinesBlock("assistant", () => []))
  pane.add(new LinesBlock("tool", () => ["  └ Read b.ts"]))
  pane.add(new LinesBlock("assistant", () => ["  Done."]))
  expect(pane.render(env(), 6)).toEqual(["  › prompt", "", "  ├ Read a.ts", "  └ Read b.ts", "", "  Done."])
})

test("stored entry clocks attach without changing message objects", () => {
  const message: UserMessage = { role: "user", content: [{ type: "text", text: "restored" }] }
  expect(messageTimestamp(message)).toBeUndefined()
  rememberMessageTime(message, at)
  expect(messageTimestamp(message)).toBe(at)
  expect(Object.keys(message)).toEqual(["role", "content"])
  expect(userLines(plain.theme, message, 80)[0]).toEndWith("20:09  ")
})

test("tool copies follow runtime ASCII arms and blank final continuations", () => {
  setGlyphs({ treeBranch: "|-", treeLast: "`-", treePipe: "|" })
  try {
    const tool = new ToolBlock("c", "read", { path: "a.ts" }, "s")
    tool.end = { result: textResult("contents") }
    tool.last = true
    const rows = tool.lines(env()).map(stripAnsi)
    expect(rows).toEqual(["  `- read a.ts  ✓ contents"])
    expect(tool.copyRows(rows).map((row) => row.from)).toEqual([5])
  } finally {
    setGlyphs()
  }
})
