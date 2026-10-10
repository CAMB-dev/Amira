import { expect, test } from "bun:test"
import type { UiTreeItem, ViewSegment } from "@amira/api"
import { textWidth } from "@amira/tui-kit"
import { glyphs, setGlyphs } from "../../src/glyphs.ts"
import { TreeIndex, treeIndent } from "../../src/ui-runtime/tree.ts"

const row: ViewSegment[] = [{ kind: "text", text: "entry" }]
const items: UiTreeItem[] = [
  {
    key: "a",
    row,
    rail: true,
    children: [
      {
        key: "b",
        row,
        rail: true,
        children: [
          {
            key: "c",
            row,
            rail: true,
            children: [
              { key: "d", row },
              { key: "e", row },
            ],
          },
          { key: "x", row },
        ],
      },
      { key: "y", row },
    ],
  },
  { key: "z", row },
]

test.each(["|", "𝄞"])("tree rails trim cells without splitting the %s glyph", (replacement) => {
  const before = { ...glyphs }
  setGlyphs({ output: replacement, treeBranch: replacement, result: replacement, rule: "-" })
  try {
    const tree = new TreeIndex()
    tree.prepare(items, ["a", "b", "c"], 12, () => [])
    const index = tree.byKey.get("d")!
    const full = treeIndent(tree, index, 12)
    expect(full).toBe(`${replacement} ${replacement} ${replacement}-`)
    expect(textWidth(full)).toBe(6)
    const narrow = treeIndent(tree, index, 11)
    expect(narrow).toBe(` ${replacement} ${replacement}-`)
    expect(textWidth(narrow)).toBe(5)
  } finally {
    setGlyphs(before)
  }
})
