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
  timestampIn,
  timestampRoom,
  timestampRow,
  userBandPaddingIn,
  userLines,
} from "../src/format.ts"
import { historyBlocks } from "../src/fullscreen/history-blocks.ts"
import { setGlyphs } from "../src/glyphs.ts"
import { historyLines } from "../src/history.ts"
import { Transcript } from "../src/transcript.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"
import { renderViewLines } from "../src/view-lines.ts"
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
  expect(rows).toHaveLength(4)
  expect(userBandPaddingIn(lines)).toBe(1)
  expect(lines[0]).toBe(`\x1b[48;2;32;32;32m${" ".repeat(40)}\x1b[49m`)
  expect(lines[3]).toBe(lines[0])
  expect(rows[1]).toStartWith("  › Hello there.")
  expect(rows[1]).toEndWith("20:09  ")
  expect(rows[2]?.trimEnd()).toBe("    Next line.")
  expect(lines[1]).toContain(banded.accent("›"))
  expect(lines[1]).toContain(banded.muted("20:09"))
  expect(timestampIn(lines)).toEqual({ line: 1, text: "20:09", width: 24, to: 16 })
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
  const inline = blocks.flatMap((block) => t.block(block.kind, block.lines(e)))
  const pane = new TranscriptPane()
  for (const block of blocks) pane.add(block)
  const fullscreen = pane.render(e, 11)
  const expected = [
    " ".repeat(40),
    `  › Hello there.${" ".repeat(17)}20:09  `,
    `    Next line.${" ".repeat(26)}`,
    " ".repeat(40),
    "",
    "  Done.",
    "",
    " ".repeat(40),
    `  › Hello there.${" ".repeat(17)}20:09  `,
    `    Next line.${" ".repeat(26)}`,
    " ".repeat(40),
  ]
  for (const rows of [inline, fullscreen]) {
    expect(rows.map(stripAnsi)).toEqual(expected)
    expect(rows.filter((row) => row === "")).toHaveLength(2)
    expect(rows[4]).toBe("")
    expect(rows[6]).toBe("")
    for (const line of [0, 3, 7, 10]) expect(rows[line]).toBe(`\x1b[48;2;32;32;32m${" ".repeat(40)}\x1b[49m`)
  }
  pane.selectText({ block: blocks[0]!, line: 0, col: 8 }, { block: blocks[2]!, line: 3, col: 9 })
  expect(pane.selectedText()).toBe("Hello there.\nNext line.\n\nDone.\n\nHello there.\nNext line.")
})

test("shared user rendering pads live, resumed and semantic view messages after their notes", () => {
  const e = { ...env(40), theme: banded }
  const message: UserMessage = {
    role: "user",
    content: [{ type: "text", text: "expanded command" }],
    display: { text: "/review", note: "Loaded" },
  }
  const block = userBlock(message)
  const pane = new TranscriptPane()
  pane.add(block)
  const history = historyBlocks([message], () => e, {
    hyperlinks: false,
    noticeBlock: () => {
      throw new Error("unexpected notice")
    },
    sessionId: () => "s",
    terminal: { columns: e.width },
  })
  const expected = [
    " ".repeat(40),
    `  › /review${" ".repeat(29)}`,
    `    └ Loaded${" ".repeat(28)}`,
    " ".repeat(40),
  ]
  for (const rows of [
    userLines(banded, message, 40),
    new Transcript().block("user", block.lines(e)),
    pane.render(e, 4),
    historyLines(banded, [message], { width: 40 }).slice(2),
    history.flatMap((b) => b.lines(e)),
    renderViewLines([{ kind: "user-message", text: "/review", note: "Loaded" }], banded, 40),
  ]) {
    expect(rows.map(stripAnsi)).toEqual(expected)
    expect(rows[0]).toBe(`\x1b[48;2;32;32;32m${" ".repeat(40)}\x1b[49m`)
    expect(rows.at(-1)).toBe(rows[0])
  }
})

test("band padding is skipped by exact copy, text marking, word/line selection and partial drags", () => {
  const block = userBlock(user)
  const pane = new TranscriptPane()
  const e = { ...env(40), theme: banded }
  pane.add(block)
  const lines = block.lines(e)
  expect(block.copyRows(lines.map(stripAnsi), lines)).toEqual([
    { from: 0, skip: true },
    { from: 4, to: 16, exact: "Hello there." },
    { from: 4 },
    { from: 0, skip: true },
  ])
  expect(block.copyText()).toBe("Hello there.\nNext line.")
  pane.render(e, 4)
  pane.selectText({ block, line: 0, col: 8 }, { block, line: 3, col: 9 })
  expect(pane.selectedText()).toBe("Hello there.\nNext line.")
  const selected = pane.render(e, 4)
  expect(selected[0]).toBe(lines[0])
  expect(selected[3]).toBe(lines[3])
  for (const line of [0, 3]) {
    expect(pane.selectWord(line, 8)).toBe(false)
    expect(pane.selectLine(line, 8)).toBe(false)
  }
  pane.startDrag(0, 8)
  pane.dragTo(1, 8)
  expect(pane.selectedText()).toBe("Hello")
  expect(pane.render(e, 4)[0]).toBe(lines[0])
  pane.endDrag()
  pane.startDrag(3, 8)
  pane.dragTo(2, 9)
  expect(pane.selectedText()).toBe("line.")
  expect(pane.render(e, 4)[3]).toBe(lines[3])
  pane.endDrag()
  pane.selectText({ block, line: 0, col: 1 }, { block, line: 0, col: 20 })
  expect(pane.selectedText()).toBe("")
  expect(pane.render(e, 4)[0]).toBe(lines[0])
})

test("band padding is not searchable text or an extra join after wrapped content", () => {
  const pane = new TranscriptPane()
  const e = { ...env(14), theme: banded }
  pane.add(userBlock({ role: "user", content: [{ type: "text", text: "hello world" }] }))
  const rows = pane.render(e, 4)
  expect(rows.map((r) => stripAnsi(r).trimEnd())).toEqual(["", "  › hello", "    world", ""])
  pane.find("hello world")
  expect(pane.matchCount).toBe(1)
  pane.find("world\n")
  expect(pane.matchCount).toBe(0)
  pane.find("\n")
  expect(pane.matchCount).toBe(0)
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
  pane.render({ ...env(40), theme: banded }, 3)
  const select = (from: number, to: number) => {
    pane.selectText({ block, line: 1, col: from }, { block, line: 1, col: to })
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
