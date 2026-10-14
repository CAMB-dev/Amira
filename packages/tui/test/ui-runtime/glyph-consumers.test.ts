import { expect, test } from "bun:test"
import type { UiNode } from "@amira/api"
import { monoTheme, stripAnsi } from "@amira/tui-kit"
import { glyphs, setGlyphs } from "../../src/glyphs.ts"
import { UiRuntime } from "../../src/ui-runtime/runtime.ts"
import { renderViewLines } from "../../src/view-lines.ts"

const widgets: UiNode[] = [
  { type: "text", id: "widget", lines: [{ kind: "text", text: "Body" }] },
  { type: "input", id: "widget", placeholder: "Type here" },
  { type: "tabs", id: "widget", tabs: [{ key: "body", label: "Body", body: { type: "spacer" } }] },
  {
    type: "table",
    id: "widget",
    columns: [{ key: "name", label: "Name" }],
    rows: [{ key: "row", cells: { name: "Body" } }],
  },
  {
    type: "tree",
    id: "widget",
    expanded: "all",
    items: [
      { key: "row", row: [{ kind: "text", text: "Body" }], detail: [{ kind: "text", text: "Detail" }] },
    ],
  },
]

for (const node of widgets) {
  test(`configured ASCII pointer reaches declarative ${node.type} selection and focus`, () => {
    const before = { ...glyphs }
    const runtime = new UiRuntime(() => {})
    const render = (height = 3) =>
      runtime
        .render(node, 30, height, monoTheme, (lines, width) => renderViewLines(lines, monoTheme, width))
        .map(stripAnsi)
    try {
      setGlyphs({ pointer: ">" })
      runtime.setState({ focused: "widget" })
      const rows = render()
      expect(rows[0]).toStartWith("> ")
      expect(rows.join("\n")).not.toContain("›")
      if (node.type === "table") expect(rows[1]).toStartWith("> Body")
      if (node.type === "tree") {
        runtime.setState({ focused: undefined })
        expect(render()[0]).toStartWith("> ")
        runtime.setState({ focused: "widget", scroll: { widget: { top: 1, following: false } } })
        expect(render(1)[0]).toStartWith("> ")
        expect(render(1)[0]).toContain("Detail")
      }
    } finally {
      runtime.dispose()
      setGlyphs(before)
    }
  })
}
