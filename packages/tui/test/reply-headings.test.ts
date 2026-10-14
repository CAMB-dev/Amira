// D deliberate oracles: heading levels styled without visible # markers; full-block source copy is unchanged.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  createTheme,
  defaultGlyphs,
  fg256,
  stripAnsi,
  stripColors,
  type ThemeDefinition,
  visibleWidth,
} from "@amira/tui-kit"
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

for (const name of ["amira", "amber", "burnt", "lavender", "mono", "ascii"]) {
  for (const appearance of ["dark", "light"] as const) {
    test(`${name} ${appearance} reply headings retain their hierarchy in streaming, finished and printed rows`, () => {
      const definition: ThemeDefinition = JSON.parse(
        readFileSync(new URL(`../../cli/themes/${name}.json`, import.meta.url), "utf8"),
      )
      const theme = createTheme({
        env: {},
        platform: "other",
        colorDepth: "truecolor",
        definition,
        themeVariant: appearance,
      })
      const e = { ...env, theme }
      const source = "# Heading\n\n## Heading\n\n### Heading"
      for (const streaming of [false, true]) {
        const reply = new ReplyBlock("", streaming, false)
        for (const char of source) {
          reply.append(char)
          reply.lines(e)
        }
        const rows = reply.lines(e)
        expect(rows.map(stripAnsi)).toEqual([
          `${glyphs.assistant}Heading`,
          "",
          `${glyphs.assistant}Heading`,
          "",
          `${glyphs.assistant}Heading`,
        ])
        const headings = [rows[0]!, rows[2]!, rows[4]!]
        expect(new Set(headings).size).toBe(3)
        expect(headings.map(stripColors)).toEqual([
          `${glyphs.assistant}\x1b[1m\x1b[4mHeading\x1b[24m\x1b[22m`,
          `${glyphs.assistant}\x1b[1mHeading\x1b[22m`,
          `${glyphs.assistant}\x1b[1m\x1b[3mHeading\x1b[23m\x1b[22m`,
        ])
        expect(reply.printLines(e)).toEqual(rows)
        reply.finish()
        expect(reply.lines(e)).toEqual(rows)
        expect(reply.copyText()).toBe(source)
      }
    })
  }
}

test("reply headings use level styles without markers in streaming, finished and printed rows", () => {
  const source = "# Title\n\n## Subtitle\n\n### Detail"
  for (const streaming of [false, true]) {
    const reply = new ReplyBlock(source, streaming, false, 0)
    const rows = reply.lines(env)
    expect(rows).toEqual(reply.printLines(env))
    expect(rows[0]).toContain(theme.heading1("Title"))
    expect(rows[2]).toBe(glyphs.assistant + theme.heading("Subtitle"))
    expect(rows[4]).toBe(glyphs.assistant + theme.subheading("Detail"))
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
  expect(pane.selectedText()).toBe("Title\n\nSubtitle\n\nDetail")
  expect(reply.copyText()).toBe(source)
  pane.selectText({ block: reply, line: 2, col: 0 }, { block: reply, line: 2, col: Number.POSITIVE_INFINITY })
  expect(pane.selectedText()).toBe("Subtitle")
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
  expect(streamed[0]).toContain(theme.subheading("Heading text"))
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
  expect(pane.selectedText()).toStartWith("Heading text")
})
