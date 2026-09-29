import { expect, test } from "bun:test"
import { defaultGlyphs, graphemes, textWidth } from "@amira/tui-kit"
import { glyphs } from "../src/glyphs.ts"

/** Every grapheme of a glyph table, with where it came from. */
function cells(table: object): [string, string][] {
  return (Object.entries(table) as [string, string | string[]][]).flatMap(([name, v]) =>
    (Array.isArray(v) ? v : [v]).flatMap((s) => graphemes(s).map((g): [string, string] => [name, g])),
  )
}

test("no glyph is an emoji drawn without asking for it", () => {
  // A non-ASCII character with an emoji form needs VS16 (two cells), unless it is one the
  // terminals' fonts draw themselves in one cell (measured as one).
  const bare = [...cells(glyphs), ...cells(defaultGlyphs)].filter(
    ([, g]) =>
      g.codePointAt(0)! > 0x7f && /\p{Emoji}/u.test(g) && !g.includes("\uFE0F") && textWidth(g) !== 1,
  )
  expect(bare).toEqual([])
})

test("glyphs are one cell each, except the emoji ones: the warning and the image", () => {
  const wide = new Set(["warning", "image"])
  for (const [name, g] of [...cells(glyphs), ...cells(defaultGlyphs)])
    expect([name, g, textWidth(g)]).toEqual([name, g, wide.has(name) ? 2 : 1])
})
