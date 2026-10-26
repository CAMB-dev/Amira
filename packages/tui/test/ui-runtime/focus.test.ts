import { expect, test } from "bun:test"
import type { UiEvent, UiNode } from "@amira/api"
import { bold, CURSOR_MARKER, defaultTheme, key, monoTheme, stripAnsi, textKey } from "@amira/tui-kit"
import { UiRuntime } from "../../src/ui-runtime/runtime.ts"
import { renderViewLines } from "../../src/view-lines.ts"

const text: UiNode = { type: "text", id: "text", lines: [{ kind: "text", text: "Reading" }] }
const tree: UiNode = {
  type: "tree",
  id: "list",
  items: ["first", "second"].map((key) => ({ key, row: [{ kind: "text", text: key }] })),
}
const table: UiNode = {
  type: "table",
  id: "list",
  columns: [{ key: "name", label: "Name" }],
  rows: ["first", "second"].map((key) => ({ key, cells: { name: key } })),
}

for (const theme of [defaultTheme, monoTheme]) {
  const mode = theme === monoTheme ? "mono" : "color"
  for (const node of [tree, table]) {
    test(`unfocused ${node.type} dims its selected row without changing state in ${mode}`, () => {
      const events: UiEvent[] = []
      const runtime = new UiRuntime((event) => events.push(event))
      runtime.setState({ selected: { list: "second" }, focused: "list" })
      const render = (focused = true) =>
        runtime.render(node, 24, 4, theme, (ls, w) => renderViewLines(ls, theme, w), true, focused)
      const focused = render()
      const state = structuredClone(runtime.state)
      const unfocused = render(false)
      const index = node.type === "tree" ? 1 : 2
      const selected = (node.type === "tree" ? "›   second" : "› second").padEnd(24)
      // Focused, the selected row is bold accent like a host picker's cursor row, not inverse.
      expect(focused[index]).toContain(bold(theme.accent(selected)))
      expect(focused[index]).not.toContain(theme.selection!(selected))
      expect(unfocused[index]).toContain(theme.dim(selected))
      expect(unfocused[index]).not.toContain(bold(theme.accent(selected)))
      expect(unfocused.map(stripAnsi)).toEqual(focused.map(stripAnsi))
      expect(runtime.state).toEqual(state)
      expect(events).toEqual([])
      expect(render()).toEqual(focused)
      if (node.type === "table") expect(unfocused[0]).toContain(theme.dim("› "))
    })
  }

  test(`unfocused input hides its caret but preserves its position and widget focus in ${mode}`, () => {
    const runtime = new UiRuntime(() => {})
    const node: UiNode = { type: "input", id: "input", activate: "/", placeholder: "Search" }
    runtime.setState({ focused: "input", inputValues: { input: "abc" } })
    const render = (cursor = true, focused = true) =>
      runtime.render(node, 24, 1, theme, (ls, w) => renderViewLines(ls, theme, w), cursor, focused)
    render()
    runtime.handleInput(key("left"))
    const focused = render()
    const state = structuredClone(runtime.state)
    expect(focused.join("")).toContain(CURSOR_MARKER)
    const unfocused = render(true, false)
    expect(unfocused.join("")).not.toContain(CURSOR_MARKER)
    expect(unfocused[0]).toContain(theme.dim("› "))
    expect(runtime.state).toEqual(state)
    expect(runtime.typing).toBe(true)
    expect(render()).toEqual(focused)
    expect(render(false).join("")).not.toContain(CURSOR_MARKER)
    runtime.handleInput(textKey("X"))
    expect(runtime.state.inputValues.input).toBe("abXc")
    runtime.setState({ inputValues: { input: "" } })
    expect(render(true, false).join("")).not.toContain(CURSOR_MARKER)
  })

  for (const style of ["brackets", "divided"] as const) {
    test(`unfocused ${style} tabs dim the active label in ${mode}`, () => {
      const runtime = new UiRuntime(() => {})
      const node: UiNode = {
        type: "tabs",
        id: "tabs",
        style,
        tabs: [{ key: "reading", label: "Reading", body: text }],
      }
      const render = (focused = true) =>
        runtime.render(node, 30, 3, theme, (ls, w) => renderViewLines(ls, theme, w), true, focused)
      const focused = render()
      const state = structuredClone(runtime.state)
      const unfocused = render(false)
      const label = style === "divided" && theme !== monoTheme ? "Reading" : "[Reading]"
      expect(unfocused[0]).toContain(theme.dim(label))
      expect(unfocused[0]).toContain(theme.dim("› "))
      expect(unfocused.map(stripAnsi)).toEqual(focused.map(stripAnsi))
      expect(runtime.state).toEqual(state)
    })
  }

  test(`unfocused text focus markers and focus-tone borders are dim in ${mode}`, () => {
    const runtime = new UiRuntime(() => {})
    const node: UiNode = { type: "box", tone: "focus", child: text }
    const render = (focused = true) =>
      runtime.render(node, 20, 4, theme, (ls, w) => renderViewLines(ls, theme, w), true, focused)
    const focused = render()
    const unfocused = render(false)
    expect(unfocused[0]).toContain(theme.dim("┏"))
    expect(unfocused[1]).toContain(theme.dim("› "))
    expect(unfocused.map(stripAnsi)).toEqual(focused.map(stripAnsi))
  })
}

test("selectable reports visible identified rows and tabs, not text, inputs or display-only tables", () => {
  const runtime = new UiRuntime(() => {})
  const render = (node: UiNode, height = 4) => runtime.render(node, 30, height, monoTheme, () => [])
  expect(runtime.selectable).toBe(false)
  for (const node of [
    text,
    { type: "input", id: "input" },
    { type: "tree", id: "empty", items: [] },
    { type: "table", id: "empty", columns: [], rows: [] },
    { type: "tabs", id: "empty", tabs: [] },
    { ...table, id: undefined },
    { type: "column", children: [{ size: 0, node: tree }, { node: text }] },
  ] satisfies UiNode[]) {
    render(node)
    expect(runtime.selectable).toBe(false)
  }
  for (const node of [
    tree,
    table,
    { type: "tabs", id: "tabs", tabs: [{ key: "text", label: "Text", body: text }] },
    { type: "box", child: tree },
  ] satisfies UiNode[]) {
    render(node)
    expect(runtime.selectable).toBe(true)
  }
  render(tree, 0)
  expect(runtime.selectable).toBe(false)
  render(tree)
  runtime.clearFrame()
  expect(runtime.selectable).toBe(false)
  render(table)
  runtime.dispose()
  expect(runtime.selectable).toBe(false)
})
