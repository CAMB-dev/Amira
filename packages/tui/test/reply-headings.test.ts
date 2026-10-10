import { expect, test } from "bun:test"
import { defaultGlyphs, fg256, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import type { BlockEnv } from "../src/blocks/base.ts"
import { ReplyBlock } from "../src/blocks/reply.ts"
import { glyphs } from "../src/glyphs.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"

const theme = {
  ...plain.theme,
  accent: fg256(45),
  heading1: fg256(111),
  heading: fg256(112),
  subheading: fg256(113),
}
const env: BlockEnv = {
  theme,
  glyphs: defaultGlyphs,
  width: 30,
  now: 0,
  spinner: "*",
  detail: "summary",
  presenters: undefined,
  hyperlinks: false,
  nodes: new Map(),
}

test("reply headings use accent markers in streaming, finished and printed rows", () => {
  const source = "# Title\n\n## Subtitle\n\n### Detail"
  for (const streaming of [false, true]) {
    const reply = new ReplyBlock(source, streaming, false, 0)
    const rows = reply.lines(env)
    expect(rows).toEqual(reply.printLines(env))
    expect(rows[0]).toContain(theme.accent("# ") + theme.heading1("Title"))
    expect(rows[2]).toBe(glyphs.assistant + theme.accent("## ") + theme.heading("Subtitle"))
    expect(rows[4]).toBe(glyphs.assistant + theme.accent("### ") + theme.subheading("Detail"))
    expect(rows.every((row) => visibleWidth(row) <= env.width)).toBe(true)
    reply.finish()
    expect(reply.lines(env)).toEqual(rows)
  }
})

test("mouse heading copy retains the same markers as full reply copy, without the clock or reply inset", () => {
  const source = "# Title\n\n## Subtitle\n\n### Detail"
  const reply = new ReplyBlock(source, false, false, 0)
  const pane = new TranscriptPane()
  pane.add(reply)
  pane.render(env, 20)
  const rows = pane.plain(reply, env)
  pane.selectText(
    { block: reply, line: 0, col: 0 },
    { block: reply, line: rows.length - 1, col: Number.POSITIVE_INFINITY },
  )
  expect(pane.selectedText()).toBe(source)
  expect(reply.copyText()).toBe(source)
  pane.selectText({ block: reply, line: 2, col: 0 }, { block: reply, line: 2, col: Number.POSITIVE_INFINITY })
  expect(pane.selectedText()).toBe("## Subtitle")
})

test("heading wraps keep timestamp widths and stream parity without repeating markers", () => {
  const source = "### Heading text with wide 界 characters and a long continuation"
  const reply = new ReplyBlock("", true, false, 0)
  const e = { ...env, width: 24 }
  for (const char of source) {
    reply.append(char)
    reply.lines(e)
  }
  const streamed = reply.lines(e)
  expect(streamed.every((row) => visibleWidth(row) <= e.width)).toBe(true)
  expect(streamed[0]).toContain(theme.accent("### "))
  expect(streamed.slice(1).some((row) => stripAnsi(row).includes("#"))).toBe(false)
  expect(reply.printLines(e)).toEqual(streamed)
  reply.finish()
  expect(reply.lines(e)).toEqual(streamed)
  const pane = new TranscriptPane()
  pane.add(reply)
  pane.render(e, 20)
  pane.selectText(
    { block: reply, line: 0, col: 0 },
    { block: reply, line: streamed.length - 1, col: Number.POSITIVE_INFINITY },
  )
  expect(pane.selectedText()).toStartWith("### ")
})
