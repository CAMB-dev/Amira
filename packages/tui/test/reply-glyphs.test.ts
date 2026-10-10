import { expect, test } from "bun:test"
import { defaultGlyphs, type Glyphs, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import type { BlockEnv } from "../src/blocks/base.ts"
import { codeFrames, ReplyBlock } from "../src/blocks/reply.ts"
import { glyphs } from "../src/glyphs.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"

const ascii: Glyphs = { ...defaultGlyphs, codeTop: "+-", codeSide: "|", codeBottom: "+-" }

const env = (markdownGlyphs: Glyphs, width = 24): BlockEnv => ({
  theme: plain.theme,
  glyphs: markdownGlyphs,
  width,
  now: 0,
  spinner: "*",
  detail: "summary",
  presenters: undefined,
  hyperlinks: false,
  nodes: new Map(),
})

test("code frames keep their default shape and detect custom ASCII frames at an indent", () => {
  expect(codeFrames(["  ╭─ ts", "  │ code", "  ╰─"])).toEqual([{ top: 0, bottom: 2, rows: [1], col: 4 }])
  expect(codeFrames(["+- ts", "| code", "+-"], ascii)).toEqual([{ top: 0, bottom: 2, rows: [1], col: 2 }])
  expect(codeFrames(["..  +- ts", "..  | code", "..  +-"], ascii, "..")).toEqual([
    { top: 0, bottom: 2, rows: [1], col: 6 },
  ])
  expect(codeFrames(["..+- ts", "..| partial"], ascii, "..")).toEqual([{ top: 0, rows: [1], col: 4 }])
})

test("custom ASCII frames support code navigation and copying wrapped code with tabs", () => {
  const assistant = glyphs.assistant
  glyphs.assistant = ".."
  try {
    const first = "const long = 'a string that wraps across several rows'\n\tindented()"
    const second = "second()"
    const reply = new ReplyBlock(`\`\`\`ts\n${first}\n\`\`\`\n\n\`\`\`\n${second}\n\`\`\``, false, false)
    const pane = new TranscriptPane()
    const e = env(ascii)
    pane.add(reply)
    pane.render(e, 30)
    const frames = pane.codeBlocks(reply)
    expect(frames).toHaveLength(2)
    expect(frames[0]!.rows.length).toBeGreaterThan(2)
    pane.select(reply)
    expect(pane.selectCode(0)).toBe(true)
    expect(pane.selectedCode?.index).toBe(0)
    expect(pane.codeText()).toBe(first)
    expect(pane.selectCode(1)).toBe(true)
    expect(pane.selectedCode?.index).toBe(1)
    expect(pane.codeText()).toBe(second)
    expect(pane.selectCode(-1)).toBe(true)
    expect(pane.codeText()).toBe(first)

    pane.selectText(
      { block: reply, line: 0, col: 0 },
      { block: reply, line: pane.lines(reply, e).length - 1, col: Number.POSITIVE_INFINITY },
    )
    expect(pane.selectedText()).toBe(`${first}\n\n${second}`)
  } finally {
    glyphs.assistant = assistant
  }
})

for (const quoteBar of ["|", "[", ".*"]) {
  test(`quote copying escapes ${JSON.stringify(quoteBar)} and strips a nonspace assistant prefix`, () => {
    const assistant = glyphs.assistant
    glyphs.assistant = ".."
    try {
      const reply = new ReplyBlock("> quoted\n\n> > nested\n\nordinary", false, false)
      const e = env({ ...ascii, quoteBar }, 60)
      const pane = new TranscriptPane()
      pane.add(reply)
      pane.render(e, 20)
      const rows = pane.plain(reply, e)
      const copied = reply.copyRows(rows, pane.lines(reply, e))
      const quoted = rows.findIndex((row) => row.includes("quoted"))
      const nested = rows.findIndex((row) => row.includes("nested"))
      expect(quoted).toBeGreaterThanOrEqual(0)
      expect(nested).toBeGreaterThanOrEqual(0)
      expect(copied[quoted]!.from).toBe(2 + visibleWidth(quoteBar) + 1)
      expect(copied[nested]!.from).toBe(2 + 2 * (visibleWidth(quoteBar) + 1))
      pane.selectText(
        { block: reply, line: 0, col: 0 },
        { block: reply, line: rows.length - 1, col: Number.POSITIVE_INFINITY },
      )
      const text = pane.selectedText()
      expect(text).toContain("quoted")
      expect(text).toContain("nested")
      expect(text).toContain("ordinary")
      expect(text).not.toContain(quoteBar)
      expect(text).not.toContain("..")
    } finally {
      glyphs.assistant = assistant
    }
  })
}

test("code frames keep display columns separate from surrogate glyph character offsets", () => {
  const assistant = glyphs.assistant
  glyphs.assistant = "𝄞."
  try {
    const markdownGlyphs = { ...ascii, codeSide: "𝄞" }
    const reply = new ReplyBlock("```\n\tfirst line that wraps over rows\n  second\n```", false, false)
    const pane = new TranscriptPane()
    const e = env(markdownGlyphs, 20)
    pane.add(reply)
    pane.render(e, 20)
    const frame = pane.codeBlocks(reply)[0]!
    const prefix = `${glyphs.assistant}${markdownGlyphs.codeSide} `
    expect(frame.col).toBe(visibleWidth(prefix))
    expect(frame.textCol).toBe(prefix.length)
    expect(frame.textCol).not.toBe(frame.col)
    expect(stripAnsi(pane.lines(reply, e)[frame.rows[0]!]!).startsWith(prefix)).toBe(true)
    const copied = reply.copyRows(pane.plain(reply, e), pane.lines(reply, e))
    expect(copied[frame.rows[0]!]!.exact).toBe("\tfirst line that wraps over rows")
    expect(copied[frame.rows[1]!]!.joins).toBe(true)
    pane.select(reply)
    expect(pane.selectCode(0)).toBe(true)
    expect(pane.codeText()).toBe("\tfirst line that wraps over rows\n  second")
  } finally {
    glyphs.assistant = assistant
  }
})

test("copy rows retain the glyphs used for rendering after the assistant prefix changes", () => {
  const assistant = glyphs.assistant
  glyphs.assistant = ".."
  try {
    const reply = new ReplyBlock("```\ncode\n```\n\n> quoted", false, false)
    const lines = reply.lines(env({ ...ascii, quoteBar: "|" }))
    const rows = lines.map(stripAnsi)
    glyphs.assistant = "different"
    const copied = reply.copyRows(rows, lines)
    expect(copied[0]!.skip).toBe(true)
    expect(copied[1]).toEqual({ from: 4, exact: "code" })
    const quote = rows.findIndex((row) => row.includes("quoted"))
    expect(copied[quote]!.from).toBe(4)
  } finally {
    glyphs.assistant = assistant
  }
})
