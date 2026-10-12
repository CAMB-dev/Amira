import { expect, test } from "bun:test"
import type { ToolPresenter } from "@amira/api"
import { defaultTheme, stripAnsi, visibleWidth } from "@amira/tui-kit"
import type { BlockEnv } from "../src/blocks/base.ts"
import { ToolBlock } from "../src/blocks/tool.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"

const env = (presenter: ToolPresenter): BlockEnv => ({
  theme: defaultTheme,
  width: 90,
  now: 1000,
  spinner: "*",
  detail: "full",
  presenters: { get: () => presenter },
  hyperlinks: false,
  nodes: new Map(),
})

function tool(presenter: ToolPresenter, last: boolean) {
  const block = new ToolBlock("call", "ordinary_tool", {}, "session")
  block.end = { result: { content: [{ type: "text", text: "done" }] } }
  block.last = last
  const e = env(presenter)
  const pane = new TranscriptPane()
  pane.add(block)
  return { block, e, pane }
}

test("search keeps literal glyph-prefixed tool content and highlights only that content", () => {
  const content = ["• item", "✓ literal success", "│ literal rail"]
  const presenter: ToolPresenter = {
    result: () => "done",
    body: () => content.map((text) => ({ kind: "text", text })),
  }
  for (const last of [false, true]) {
    const { block, e, pane } = tool(presenter, last)
    const rows = block.lines(e)
    expect(rows.find((row) => stripAnsi(row).includes("• item"))).toContain(defaultTheme.text("• item"))
    pane.render(e, 20)
    for (const query of content) {
      pane.find(query)
      expect(pane.matchCount).toBe(1)
      const marked = pane.render(e, 20).filter((row) => row.includes("\x1b[7;4m"))
      expect(marked).toHaveLength(1)
      const from = marked[0]!.indexOf("\x1b[7;4m")
      const to = marked[0]!.indexOf("\x1b[27;24m", from)
      expect(stripAnsi(marked[0]!.slice(from, to))).toBe(query)
      expect(stripAnsi(marked[0]!.slice(0, from))).toBe(last ? "     " : "  │  ")
    }
  }
})

test("a choice matching the result label retains its description, styling, search and copy", () => {
  const presenter: ToolPresenter = {
    result: () => "Patch",
    body: () => [{ kind: "text", text: "Patch", marker: "success", description: "Fix it in place" }],
  }
  for (const last of [false, true]) {
    const { block, e, pane } = tool(presenter, last)
    const rows = block.lines(e)
    const text = rows.map(stripAnsi)
    const choice = text.findIndex((row) => row.includes("Fix it in place"))
    expect(choice).toBeGreaterThan(1)
    expect(text[choice]).toBe(last ? "     ✓ Patch  Fix it in place" : "  │  ✓ Patch  Fix it in place")
    expect(rows[choice]).toContain(defaultTheme.success("✓ "))
    expect(rows[choice]).toContain(defaultTheme.text("Patch"))
    expect(rows[choice]).toContain(defaultTheme.muted("  Fix it in place"))
    pane.render(e, 20)
    pane.find("Fix it in place")
    expect(pane.matchCount).toBe(1)
    pane.selectText({ block, line: choice, col: 0 }, { block, line: choice, col: 89 })
    expect(pane.selectedText()).toBe("✓ Patch  Fix it in place")
  }
})

test("description-implied wrapping survives every multiline tool-label fragment", () => {
  const label = `${"A ".repeat(40)}\ntail`
  for (const last of [false, true]) {
    const render = (wrap?: boolean) => {
      const presenter: ToolPresenter = {
        result: () => "done",
        body: () => [
          { kind: "text", text: label, description: "Explanation", ...(wrap !== undefined ? { wrap } : {}) },
        ],
      }
      const { block, e } = tool(presenter, last)
      return block.lines({ ...e, width: 20 })
    }
    const explicit = render(true)
    for (const wrap of [undefined, false]) {
      const rows = render(wrap)
      const text = rows.map(stripAnsi)
      expect(text.join("\n").match(/A/g)).toHaveLength(40)
      expect(rows).toEqual(explicit)
      expect(text.filter((row) => row.includes("Explanation"))).toHaveLength(1)
      expect(rows.find((row) => stripAnsi(row).includes("A A"))).toContain(
        defaultTheme.text("A A A A A A A A"),
      )
      expect(rows.find((row) => stripAnsi(row).includes("Explanation"))).toContain(
        defaultTheme.muted("Explanation"),
      )
      expect(rows.every((row) => visibleWidth(row) <= 20)).toBe(true)
    }
  }
})

test("selection-copy distinguishes result chrome from choice marks after child insertion", () => {
  const presenter: ToolPresenter = {
    result: () => "done",
    body: () => [
      { kind: "text", text: "Patch", marker: "success", description: "One explanation" },
      { kind: "muted", text: "Docs", marker: "unchecked" },
      { kind: "text", text: "✓ literal success" },
    ],
  }
  for (const last of [false, true]) {
    const { block, e, pane } = tool(presenter, last)
    e.nodes.set("child", {
      id: "child",
      parent: "session",
      toolCallId: "call",
      title: "Child",
      role: "agent",
      depth: 1,
      startedAt: 0,
      tokens: 0,
      end: { status: "done", durationMs: 1000, tokens: 0 },
    })
    pane.render(e, 20)
    const rows = block.lines(e)
    const text = rows.map(stripAnsi)
    const result = text.findIndex((row) => row.trim().endsWith("✓ done"))
    expect(result).toBeGreaterThan(1)
    expect(rows[result]).toContain(defaultTheme.success("✓ done"))
    const selectRow = (line: number) => {
      pane.selectText({ block, line, col: 0 }, { block, line, col: 89 })
      return pane.selectedText()
    }
    expect(selectRow(result)).toBe("done")
    expect(selectRow(text.findIndex((row) => row.includes("✓ Patch")))).toBe("✓ Patch  One explanation")
    expect(selectRow(text.findIndex((row) => row.includes("[ ] Docs")))).toBe("[ ] Docs")
    expect(selectRow(text.findIndex((row) => row.includes("✓ literal success")))).toBe("✓ literal success")
  }
})
