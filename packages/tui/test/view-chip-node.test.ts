import { expect, test } from "bun:test"
import type { UiNode } from "@amira/api"
import { defaultTheme, monoTheme, stripAnsi } from "@amira/tui-kit"
import { UiRuntime } from "../src/ui-runtime/runtime.ts"
import { renderViewLines } from "../src/view-lines.ts"

test("tree node chips fit the two-cell disclosure slot without losing their ends", () => {
  const node: UiNode = {
    type: "tree",
    id: "tree",
    items: [{ key: "x", row: [{ kind: "text", text: "Ready" }], node: [{ kind: "chip", text: "" }] }],
  }
  for (const theme of [defaultTheme, monoTheme]) {
    const runtime = new UiRuntime(() => {})
    const rows = runtime.render(node, 30, 3, theme, (lines, width) => renderViewLines(lines, theme, width))
    expect(rows.map(stripAnsi).join("\n")).toContain(theme === monoTheme ? "[]Ready" : "▐▌Ready")
    runtime.dispose()
  }
})
