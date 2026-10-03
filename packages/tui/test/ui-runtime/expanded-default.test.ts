import { expect, test } from "bun:test"
import type { UiNode, UiTreeItem } from "@amira/api"
import { key, monoTheme } from "@amira/tui-kit"
import { UiRuntime } from "../../src/ui-runtime/runtime.ts"
import { renderViewLines } from "../../src/view-lines.ts"

const branch = (key: string): UiTreeItem => ({
  key,
  row: [{ kind: "text", text: key }],
  children: [{ key: `${key}-child`, row: [{ kind: "text", text: `${key}-child` }] }],
})
const tree = (items: UiTreeItem[], expanded?: "all"): UiNode => ({ type: "tree", id: "t", items, expanded })
const render = (runtime: UiRuntime, node: UiNode) =>
  runtime
    .render(node, 40, 10, monoTheme, (lines, width) => renderViewLines(lines, monoTheme, width))
    .join("\n")

test("expanded all opens nested rows and new arrivals without reopening a user collapse", () => {
  const runtime = new UiRuntime(() => {})
  const nested = branch("parent")
  nested.children!.push(branch("nested"))
  let node = tree([nested], "all")
  expect(render(runtime, node)).toContain("nested-child")
  expect(runtime.state.expanded.t).toContain("parent")
  expect(runtime.state.expanded.t).toContain("nested")
  runtime.handleInput(key("left"))
  expect(render(runtime, node)).not.toContain("parent-child")
  node = tree([nested, branch("new")], "all")
  const frame = render(runtime, node)
  expect(frame).not.toContain("parent-child")
  expect(frame).toContain("new-child")
  expect(runtime.state.expanded.t).not.toContain("parent")
  runtime.handleInput(key("right"))
  expect(render(runtime, node)).toContain("nested-child")
  // Stable keys keep their override even when an extension replaces the item objects.
  runtime.handleInput(key("left"))
  expect(render(runtime, tree([branch("parent"), branch("new")], "all"))).not.toContain("parent-child")
})

test("explicit expansion state wins over all, before and after the first frame", () => {
  const runtime = new UiRuntime(() => {})
  const node = tree([branch("a"), branch("b")], "all")
  runtime.setState({ expanded: { t: ["b"] } })
  let frame = render(runtime, node)
  expect(frame).not.toContain("a-child")
  expect(frame).toContain("b-child")
  runtime.setState({ expanded: { t: [] } })
  frame = render(runtime, node)
  expect(frame).not.toContain("a-child")
  expect(frame).not.toContain("b-child")
  runtime.handleInput(key("right"))
  expect(render(runtime, node)).toContain("a-child")
  runtime.setState({ expanded: {} }) // Removing the explicit entry restores the node default.
  expect(render(runtime, node)).toContain("b-child")
})

test("omitting expanded keeps trees collapsed and later all respects earlier user toggles", () => {
  const runtime = new UiRuntime(() => {})
  const items = [branch("a"), branch("b")]
  expect(render(runtime, tree(items))).not.toContain("a-child")
  expect(runtime.state.expanded.t).toBeUndefined()
  runtime.handleInput(key("right"))
  runtime.handleInput(key("left"))
  const frame = render(runtime, tree(items, "all"))
  expect(frame).not.toContain("a-child")
  expect(frame).toContain("b-child")
})

test("all expands newly expandable rows and remains stable after reconciliation", () => {
  const runtime = new UiRuntime(() => {})
  render(runtime, tree([{ key: "a", row: [] }], "all"))
  const node = tree([branch("a")], "all")
  expect(render(runtime, node)).toContain("a-child")
  render(runtime, node)
  expect(runtime.reconciled).toBe(false)
})
