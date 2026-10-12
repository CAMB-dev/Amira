import { expect, test } from "bun:test"
import type { AskOutcome, AskQuestion, Message, ToolResultMessage } from "@amira/api"
import { defaultTheme, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { builtinPresenters } from "../../../extensions/builtin-tools/src/index.ts"
import ascii from "../../cli/themes/ascii.json"
import type { BlockEnv } from "../src/blocks/base.ts"
import { ToolBlock } from "../src/blocks/tool.ts"
import { historyBlocks } from "../src/fullscreen/history-blocks.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
import { historyLines } from "../src/history.ts"
import { sliceCells } from "../src/text-selection.ts"
import { type FinishedCall, finishedToolLines } from "../src/tool-view.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"

const questions: AskQuestion[] = [
  {
    header: "Approach",
    question: "Which approach?",
    options: [
      { label: "Rewrite", description: "Start over" },
      { label: "Patch", description: "Fix it in place" },
    ],
  },
  {
    header: "Extras",
    question: "What else should I do?",
    multiSelect: true,
    options: [
      { label: "Tests", description: "Add regression coverage" },
      { label: "Docs", description: "Update the guide" },
      { label: "Changelog", description: "Record the change" },
    ],
  },
]
const outcome: AskOutcome = {
  answers: [{ selected: ["Patch"] }, { selected: ["Tests", "Changelog"], other: "Keep it small" }],
}
const call: FinishedCall = {
  name: "ask_user",
  args: { questions },
  result: { content: [], details: { questions, outcome } },
}
const env = (width = 90): BlockEnv => ({
  theme: defaultTheme,
  width,
  now: 0,
  spinner: "*",
  detail: "summary",
  presenters: { get: (name) => builtinPresenters[name] },
  hyperlinks: false,
  nodes: new Map(),
})
const plain = (rows: string[]) => rows.map((row) => stripAnsi(row).trimEnd())
const full = (c = call, width = 90) =>
  finishedToolLines(defaultTheme, builtinPresenters.ask_user, c, "full", width, { last: true })

test("full ask transcript at width 90 preserves choice colors and every offered description", () => {
  const rows = full()
  expect(plain(rows)).toEqual([
    "  └ Asked Which approach? (+1 more)",
    "     ✓ 2 answers",
    "     Approach",
    "     Which approach?",
    "     [ ] Rewrite  Start over",
    "     ✓ Patch  Fix it in place",
    "",
    "     Extras",
    "     What else should I do?",
    "     ✓ Tests  Add regression coverage",
    "     [ ] Docs  Update the guide",
    "     ✓ Changelog  Record the change",
    '     ✓ (own words) "Keep it small"',
  ])
  const chosen = rows.find((row) => stripAnsi(row).includes("✓ Patch"))!
  expect(chosen).toContain(defaultTheme.success("✓ "))
  expect(chosen).toContain(defaultTheme.text("Patch"))
  expect(chosen).not.toContain(defaultTheme.success("Patch"))
  expect(chosen).toContain(defaultTheme.muted("  Fix it in place"))
  const unchosen = rows.find((row) => stripAnsi(row).includes("[ ] Rewrite"))!
  expect(unchosen).toContain(defaultTheme.muted("[ ] "))
  expect(unchosen).toContain(defaultTheme.muted("Rewrite"))
  expect(unchosen).toContain(defaultTheme.muted("  Start over"))
  expect(rows.every((row) => visibleWidth(row) <= 90)).toBe(true)
})

test("full detail wraps long prose, labels and CJK without raising any line cap", () => {
  const description = "从头开始写这个模块并且保留所有未选择的说明文字。".repeat(12)
  const q: AskQuestion = {
    header: "方法",
    question: "你想用哪种方法来实现这个功能？".repeat(5),
    options: [
      { label: "重写（推荐）", description },
      { label: "修补现有模块和测试", description: "就地修复" },
    ],
  }
  const c: FinishedCall = {
    ...call,
    args: { questions: [q] },
    result: {
      content: [],
      details: { questions: [q], outcome: { answers: [{ selected: ["修补现有模块和测试"] }] } },
    },
  }
  for (const width of [20, 28, 40, 90]) {
    const rows = full(c, width)
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)
    const text = plain(rows).join("").replace(/\s/g, "")
    expect(text).toContain(description)
    expect(text).toContain(q.question)
    expect(text).toContain("✓修补现有模块和测试")
    expect(rows.length).toBeGreaterThan(12)
  }
  const rows = full(call, 32)
  expect(plain(rows)).toContain("       Add regression coverage")
  expect(rows.find((row) => stripAnsi(row).includes("Add regression"))).toContain(
    defaultTheme.muted("Add regression coverage"),
  )
})

test("a 2 MiB own-words answer renders completely at width 10 without overflowing the argument stack", () => {
  const questions: AskQuestion[] = [
    { question: "Q1?", options: [{ label: "A" }, { label: "B" }] },
    { question: "Q2?", options: [{ label: "C" }, { label: "D" }] },
  ]
  const ownWords = "x".repeat(2 * 1024 * 1024)
  const c: FinishedCall = {
    ...call,
    args: { questions },
    result: {
      content: [],
      details: { questions, outcome: { answers: [{ selected: [], other: ownWords }, { selected: ["D"] }] } },
    },
  }
  let rows: string[] = []
  expect(() => {
    rows = full(c, 10)
  }).not.toThrow()
  let shown = 0
  let withinWidth = true
  for (const row of rows) {
    withinWidth &&= visibleWidth(row) <= 10
    for (const char of stripAnsi(row)) if (char === "x") shown++
  }
  expect(withinWidth).toBe(true)
  expect(shown).toBe(ownWords.length)
  expect(rows.length).toBeGreaterThan(ownWords.length / 3)
})

test("large wrapped choice descriptions also append without overflowing the argument stack", () => {
  const description = "x".repeat(2 * 1024 * 1024)
  const questions: AskQuestion[] = [
    { question: "Which?", options: [{ label: "A", description }, { label: "B" }] },
  ]
  const c: FinishedCall = {
    ...call,
    args: { questions },
    result: { content: [], details: { questions, outcome: { declined: true } } },
  }
  let rows: string[] = []
  expect(() => {
    rows = full(c, 12)
  }).not.toThrow()
  let shown = 0
  for (const row of rows) for (const char of stripAnsi(row)) if (char === "x") shown++
  expect(shown).toBe(description.length)
  expect(rows.every((row) => visibleWidth(row) <= 12)).toBe(true)
  expect(rows.find((row) => stripAnsi(row).includes("xxx"))).toContain(defaultTheme.muted("xxx"))
})

test("multiline choices keep one marker and description with hanging continuation rows", () => {
  const questions: AskQuestion[] = [
    {
      question: "Which?",
      options: [
        { label: "First\nsecond", description: "One explanation" },
        { label: "Else\ncontinued", description: "Not chosen" },
      ],
    },
  ]
  const c: FinishedCall = {
    ...call,
    args: { questions },
    result: {
      content: [],
      details: { questions, outcome: { answers: [{ selected: ["First\nsecond"] }] } },
    },
  }
  for (const width of [20, 90]) {
    const rows = full(c, width)
    const text = plain(rows)
    const body = text.slice(text.indexOf("     Which?") + 1)
    expect(body.filter((row) => row.includes("✓"))).toEqual(["     ✓ First"])
    expect(body.filter((row) => row.includes("[ ]"))).toEqual(["     [ ] Else"])
    expect(body[1]).toBe(width === 90 ? "       second  One explanation" : "       second")
    expect(body.filter((row) => row.includes("explanation"))).toHaveLength(1)
    expect(body.map((row) => row.trim()).join(" ")).toContain("One explanation")
    expect(body.filter((row) => row.includes("continued"))).toEqual([
      width === 90 ? "         continued  Not chosen" : "         continued",
    ])
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)
    const styledBody = rows.slice(text.indexOf("     Which?") + 1)
    expect(styledBody[1]).toContain(defaultTheme.text("second"))
    expect(styledBody.find((row) => stripAnsi(row).includes("continued"))!).toContain(
      defaultTheme.muted("continued"),
    )
  }
})

test("ASCII glyphs are used for both chosen and hollow markers, including own words", () => {
  setGlyphs(ascii.glyphs)
  try {
    const rows = full()
    expect(plain(rows)).toContain("      v Patch  Fix it in place")
    expect(plain(rows)).toContain("      [ ] Rewrite  Start over")
    expect(plain(rows)).toContain('      v (own words) "Keep it small"')
    expect(rows.every((row) => visibleWidth(row) <= 90)).toBe(true)
    expect(plain(rows).join("\n")).not.toMatch(/[✓└│]/)
  } finally {
    setGlyphs()
  }
})

test("declined and unavailable keep the status and show all offered choices without success marks", () => {
  for (const outcome of [{ declined: true }, { unavailable: "no UI" }] as const) {
    const c: FinishedCall = { ...call, result: { content: [], details: { questions, outcome } } }
    const rows = plain(full(c))
    expect(rows).toContain("     [ ] Rewrite  Start over")
    expect(rows).toContain("     [ ] Patch  Fix it in place")
    expect(rows).toContain("     [ ] Docs  Update the guide")
    expect(rows.some((row) => /✓ (Patch|Tests|Changelog)/.test(row))).toBe(false)
    expect(rows[1]).toContain("declined" in outcome ? "declined" : "nobody could answer (no UI)")
    expect(finishedToolLines(defaultTheme, builtinPresenters.ask_user, c, "summary", 90)).toHaveLength(1)
  }
})

test("unfolding exposes choices to find and plain-text copy; folding keeps today's copy", () => {
  const block = new ToolBlock("ask1", call.name, call.args, "session")
  block.end = { result: call.result }
  block.last = true
  const e = env()
  const foldedCopy = block.copyText()
  expect(block.copyText(e)).toBe(foldedCopy)
  const pane = new TranscriptPane()
  pane.add(block)
  pane.render(e, 30)
  pane.find("Update the guide")
  expect(pane.matchCount).toBe(0)
  block.toggleFold(e)
  pane.render(e, 30)
  for (const query of ["Rewrite", "Update the guide", "Add regression coverage"]) {
    pane.find(query)
    expect(pane.matchCount).toBe(1)
  }
  const copy = block.copyText(e)
  expect(copy).toContain("[ ] Rewrite  Start over")
  expect(copy).toContain("✓ Patch  Fix it in place")
  expect(copy).toContain('✓ (own words) "Keep it small"')
  expect(copy).not.toContain("\x1b")
  const rows = block.lines(e)
  const text = rows.map(stripAnsi)
  const copyRows = block.copyRows(text, rows)
  const patch = text.findIndex((row) => row.includes("✓ Patch"))
  expect(sliceCells(text[patch]!, copyRows[patch]!.from, Number.POSITIVE_INFINITY)).toBe(
    "✓ Patch  Fix it in place",
  )
  block.toggleFold(e)
  expect(block.copyText(e)).toBe(foldedCopy)
})

test("narrow non-last asks find wrapped choices without highlighting tree rails", () => {
  const questions: AskQuestion[] = [
    {
      question: "Which?",
      options: [
        { label: "Regression tests", description: "Add regression coverage" },
        { label: "Docs", description: "中文句子需要换行而且能被搜索到" },
      ],
    },
  ]
  const block = new ToolBlock("ask1", "ask_user", { questions }, "session")
  block.end = { result: { content: [], details: { questions, outcome: { declined: true } } } }
  block.last = false
  const e = { ...env(20), detail: "full" as const }
  const pane = new TranscriptPane()
  pane.add(block)
  pane.render(e, 40)
  for (const query of ["Regression tests", "Add regression coverage", "中文句子需要换行而且能被搜索到"]) {
    pane.find(query)
    expect(pane.matchCount).toBe(1)
    const marked = pane.render(e, 40).filter((row) => row.includes("\x1b[7;4m"))
    expect(marked.length).toBeGreaterThan(1)
    const fragments = marked.map((row) => {
      const from = row.indexOf("\x1b[7;4m")
      const to = row.indexOf("\x1b[27;24m", from)
      expect(from).toBeGreaterThan(row.indexOf(glyphs.treePipe))
      expect(to).toBeGreaterThan(from)
      return stripAnsi(row.slice(from, to))
    })
    expect(fragments.join(visibleWidth(query[0]!) === 2 ? "" : " ")).toBe(query)
  }
})

test("hard-wrapped option words stay searchable with highlights on the original columns", () => {
  const label = "123456789012345678901234"
  const description = "abcdefghijklmnopqrstuv"
  const questions: AskQuestion[] = [
    { question: "Which?", options: [{ label, description }, { label: "Docs" }] },
  ]
  for (const last of [false, true]) {
    const block = new ToolBlock("ask1", "ask_user", { questions }, "session")
    block.end = { result: { content: [], details: { questions, outcome: { declined: true } } } }
    block.last = last
    const e = { ...env(20), detail: "full" as const }
    const pane = new TranscriptPane()
    pane.add(block)
    pane.render(e, 40)
    for (const query of [label, description]) {
      pane.find(query)
      expect(pane.matchCount).toBe(1)
      const marked = pane.render(e, 40).filter((row) => row.includes("\x1b[7;4m"))
      expect(marked.length).toBeGreaterThan(1)
      const fragments = marked.map((row) => {
        const from = row.indexOf("\x1b[7;4m")
        const to = row.indexOf("\x1b[27;24m", from)
        if (!last) expect(from).toBeGreaterThan(row.indexOf(glyphs.treePipe))
        expect(to).toBeGreaterThan(from)
        expect(visibleWidth(stripAnsi(row.slice(0, from)))).toBe(9)
        return stripAnsi(row.slice(from, to))
      })
      expect(fragments.join("")).toBe(query)
    }
    // A logical line boundary is not a hard wrap inside a word.
    pane.find(`${description}Docs`)
    expect(pane.matchCount).toBe(0)
    pane.render({ ...e, width: 90 }, 40)
    pane.find(description)
    expect(pane.matchCount).toBe(1)
  }
})

test("both history renderers restore exact choice details after message serialization", () => {
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "ask1",
    toolName: call.name,
    content: [],
    isError: false,
    details: call.result.details,
  }
  const messages: Message[] = JSON.parse(
    JSON.stringify([
      {
        role: "assistant",
        model: { provider: "mock", model: "m1" },
        content: [{ type: "toolCall", id: "ask1", name: call.name, args: call.args }],
      },
      result,
    ]),
  )
  const e = { ...env(), detail: "full" as const }
  const inline = historyLines(defaultTheme, messages, { width: 90, detail: "full", presenters: e.presenters })
  const blocks = historyBlocks(messages, () => e, {
    hyperlinks: false,
    noticeBlock: () => {
      throw new Error("unexpected notice")
    },
    sessionId: () => "session",
    terminal: { columns: 90 },
  })
  for (const rows of [inline, blocks.flatMap((block) => block.lines(e))]) {
    const text = plain(rows).join("\n")
    expect(text).toContain("✓ Patch  Fix it in place")
    expect(text).toContain("[ ] Docs  Update the guide")
    expect(text).toContain('✓ (own words) "Keep it small"')
  }
  expect(glyphs.success).toBe("✓")
})
