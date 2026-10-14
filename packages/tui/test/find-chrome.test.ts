import { expect, test } from "bun:test"
import { defaultTheme, stripAnsi } from "@amira/tui-kit"
import { type BlockEnv, LinesBlock, ReplyBlock } from "../src/blocks.ts"
import type { CopyRow } from "../src/text-selection.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"

const env: BlockEnv = {
  theme: defaultTheme,
  width: 30,
  now: 0,
  spinner: "*",
  detail: "summary",
  presenters: undefined,
  hyperlinks: false,
  nodes: new Map(),
}

class SearchRowsBlock extends LinesBlock {
  constructor(
    private readonly searchable: CopyRow[],
    lines = ["  language", "  界value suffix", "  👍tail"],
  ) {
    super("assistant", () => lines)
  }
  override searchRows(): CopyRow[] {
    return this.searchable
  }
}

test("finder excludes renderer-owned skipped rows and trailing cell ranges", () => {
  const pane = new TranscriptPane()
  pane.add(new SearchRowsBlock([{ from: 0, skip: true }, { from: 2, to: 9 }, { from: 2 }]))
  pane.render(env, 3)
  for (const chrome of ["language", "suffix", "value suffix"]) {
    pane.find(chrome)
    expect(pane.matchCount).toBe(0)
  }
  for (const body of ["界value", "value", "👍tail"]) {
    pane.find(body)
    expect(pane.matchCount).toBe(1)
  }
  pane.find("value")
  const frame = pane.render(env, 3)
  expect(stripAnsi(frame[1]!)).toBe("  界value suffix")
  expect(frame[1]).toContain("界\x1b[7;4mvalue\x1b[27;24m suffix")
})

test("fill-only code language stays visible but is absent from find across widths", () => {
  for (const width of [10, 30, 60]) {
    const pane = new TranscriptPane()
    const reply = new ReplyBlock("```txt\nvalue\n```", false, false)
    pane.add(reply)
    const e = { ...env, width }
    const frame = pane.render(e, 3)
    expect(stripAnsi(frame[0]!)).toEndWith("txt")
    pane.find("txt")
    expect(pane.matchCount).toBe(0)
    pane.find("value")
    expect(pane.matchCount).toBe(1)
    expect(pane.render(e, 3)[1]).toContain("\x1b[7;4mvalue\x1b[27;24m")
  }
})

test("skipped renderer rows remain boundaries, not searchable wrap joints", () => {
  const pane = new TranscriptPane()
  pane.add(
    new SearchRowsBlock(
      [{ from: 2 }, { from: 0, skip: true }, { from: 2, joinBefore: " " }],
      ["  first", "  language", "  tail"],
    ),
  )
  pane.render(env, 3)
  pane.find("first tail")
  expect(pane.matchCount).toBe(0)
})
