import { expect, test } from "bun:test"
import { defaultGlyphs, graphemes, textWidth } from "@amira/tui-kit"
import { glyphs } from "../src/glyphs.ts"

/** Every grapheme of a glyph table, with where it came from. */
function cells(table: Record<string, string | string[]>): [string, string][] {
  return Object.entries(table).flatMap(([name, v]) =>
    (Array.isArray(v) ? v : [v]).flatMap((s) => graphemes(s).map((g): [string, string] => [name, g])),
  )
}

test("no glyph is an emoji drawn without asking for it", () => {
  // A non-ASCII character with an emoji form is only allowed with VS16, which makes it two cells.
  const bare = [...cells(glyphs), ...cells(defaultGlyphs)].filter(
    ([, g]) => g.codePointAt(0)! > 0x7f && /\p{Emoji}/u.test(g) && !g.includes("\uFE0F"),
  )
  expect(bare).toEqual([])
})

test("the TUI's glyphs are one cell each, the markdown image glyph two", () => {
  for (const [name, g] of cells(glyphs)) expect([name, g, textWidth(g)]).toEqual([name, g, 1])
  for (const [name, g] of cells(defaultGlyphs))
    expect([name, g, textWidth(g)]).toEqual([name, g, name === "image" ? 2 : 1])
})
