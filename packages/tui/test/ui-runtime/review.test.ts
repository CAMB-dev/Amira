import { expect, test } from "bun:test"
import type { UiNode, UiTreeItem, ViewDefinition } from "@amira/api"
import { key, monoTheme, stripAnsi, textKey } from "@amira/tui-kit"
import { ExtensionViewer } from "../../src/extension-view.ts"
import { allocate } from "../../src/ui-runtime/layout.ts"
import { UiRuntime } from "../../src/ui-runtime/runtime.ts"
import { TreeIndex } from "../../src/ui-runtime/tree.ts"
import { renderViewLines } from "../../src/view-lines.ts"

const context = { theme: monoTheme, color: false, rows: 8 }

test("overconstraint preserves feasible minima before shrinking requests", () => {
  expect(allocate(10, [{ size: 100 }, { size: "fill", min: 5 }])).toEqual([5, 5])
  expect(allocate(10, [{ size: "100%" }, { size: "100%" }, { min: 5 }])).toEqual([3, 2, 5])
  expect(allocate(6, [{ size: 100, min: 4 }, { min: 4 }])).toEqual([3, 3])
})

for (const kind of ["tree", "table"] as const) {
  test(`${kind} selection-dependent details reconcile within the same frame`, () => {
    const view: ViewDefinition<string[]> = {
      kind: "selection-proof",
      title: () => "Selection",
      ui(data, ctx) {
        const list: UiNode =
          kind === "tree"
            ? {
                type: kind,
                id: "list",
                items: data.map((k) => ({ key: k, row: [{ kind: "text", text: k }] })),
              }
            : {
                type: kind,
                id: "list",
                columns: [{ key: "name", label: "Name" }],
                rows: data.map((k) => ({ key: k, cells: { name: k } })),
              }
        return {
          type: "column",
          children: [
            { node: list },
            {
              size: 1,
              node: {
                type: "text",
                lines: [{ kind: "text", text: `Detail: ${ctx.state.selected.list ?? "none"}` }],
              },
            },
          ],
        }
      },
    }
    const viewer = new ExtensionViewer(view, ["A"])
    expect(viewer.render(40, context).map(stripAnsi).join("\n")).toContain("Detail: A")
    viewer.show(["B"])
    expect(viewer.render(40, context).map(stripAnsi).join("\n")).toContain("Detail: B")
  })
}

test("pointer press and release cannot answer a confirmation", async () => {
  let answer: Promise<boolean> | undefined
  const view: ViewDefinition = {
    kind: "confirm-proof",
    title: () => "Confirm",
    ui: () => ({ type: "tree", id: "tree", items: [{ key: "ask", row: [] }] }),
    onEvent(event, _data, control) {
      if (event.type === "activate") answer = control.confirm("Continue?")
    },
  }
  const viewer = new ExtensionViewer(view, {})
  viewer.render(40, context)
  viewer.handleInput(key("enter"))
  for (const action of ["press", "release"] as const) {
    viewer.handleInput({
      type: "mouse",
      action,
      button: "left",
      x: 1,
      y: 1,
      ctrl: false,
      alt: false,
      shift: false,
    })
  }
  viewer.handleInput(textKey("y"))
  expect(await answer).toBe(true)
})

test("retained hidden expansion history is indexed only when it changes", () => {
  const child: UiTreeItem = { key: "child", row: [], children: [{ key: "leaf", row: [] }] }
  const items: UiTreeItem[] = [{ key: "root", row: [], children: [child] }]
  const tree = new TreeIndex()
  tree.prepare(items, ["root", "child"], 40, () => [])
  const collapsed = ["child"]
  let enumerations = 0
  Object.defineProperty(collapsed, Symbol.iterator, {
    value: function* () {
      enumerations++
      yield "child"
    },
  })
  tree.prepare(items, collapsed, 40, () => [])
  expect(tree.rows).toHaveLength(1)
  for (let i = 0; i < 10; i++) tree.prepare(items, collapsed, 40, () => [])
  expect(enumerations).toBe(1)
  tree.prepare(items, ["root", "child"], 40, () => [])
  expect(tree.rows).toHaveLength(3)
})

test("setState snapshots expansion arrays and invalidates the lookup even with reused caller arrays", () => {
  const runtime = new UiRuntime(() => {})
  const node: UiNode = {
    type: "tree",
    id: "t",
    items: [{ key: "parent", row: [], children: [{ key: "child", row: [] }] }],
  }
  const expanded = ["parent"]
  const render = () => runtime.render(node, 40, 5, monoTheme, () => [])
  runtime.setState({ expanded: { t: expanded } })
  render()
  expanded.pop()
  expect(runtime.state.expanded.t).toEqual(["parent"])
  runtime.setState({ expanded: { t: expanded } })
  render()
  runtime.handleInput(key("down"))
  expect(runtime.state.selected.t).toBe("parent")
})

test("tree rails connect children and continue across a nested sibling branch", () => {
  const runtime = new UiRuntime(() => {})
  runtime.setState({ expanded: { t: ["parent", "a"] } })
  const node: UiNode = {
    type: "tree",
    id: "t",
    items: [
      {
        key: "parent",
        row: [],
        rail: true,
        children: [
          {
            key: "a",
            row: [],
            rail: true,
            children: [{ key: "nested", row: [{ kind: "text", text: "Nested" }] }],
          },
          { key: "b", row: [{ kind: "text", text: "Last" }] },
        ],
      },
    ],
  }
  const lines = runtime
    .render(node, 40, 5, monoTheme, (ls, w) => renderViewLines(ls, monoTheme, w))
    .map(stripAnsi)
  expect(lines[1]).toContain("├─")
  expect(lines[2]).toContain("│ └─  Nested")
  expect(lines[3]).toContain("└─  Last")
})

test("unstable selection-dependent content fails within a bounded number of rebuilds", () => {
  let calls = 0
  const errors: string[] = []
  const viewer = new ExtensionViewer(
    {
      kind: "unstable",
      title: () => "Fallback",
      ui(_data, ctx) {
        calls++
        return { type: "tree", id: "t", items: [{ key: ctx.state.selected.t === "a" ? "b" : "a", row: [] }] }
      },
    },
    {},
    { onError: (error) => errors.push(error) },
  )
  expect(viewer.render(60, context).map(stripAnsi).join("\n")).toContain("UI state did not stabilize")
  expect(calls).toBe(8)
  expect(errors).toHaveLength(1)
  expect(viewer.handleInput(key("enter"))).toBe(false)
})
