import { expect, test } from "bun:test"
import type { UiEvent, UiNode, UiTreeItem } from "@amira/api"
import { defaultTheme, key, type MouseInput, monoTheme, stripAnsi, textKey } from "@amira/tui-kit"
import { UiRuntime } from "../../src/ui-runtime/runtime.ts"
import { renderViewLines } from "../../src/view-lines.ts"

const item = (key: string, children?: UiTreeItem[]): UiTreeItem => ({
  key,
  row: [{ kind: "text", text: key }],
  children,
})
const text = (id?: string): UiNode => ({ type: "text", id, lines: [{ kind: "text", text: "Reading" }] })
const mouse = (
  action: MouseInput["action"],
  x: number,
  y: number,
  button: MouseInput["button"] = "left",
): MouseInput => ({
  type: "mouse",
  action,
  button,
  x,
  y,
  shift: false,
  alt: false,
  ctrl: false,
})
function setup(node: UiNode, width = 30, height = 6, theme = monoTheme) {
  const events: UiEvent[] = []
  const runtime = new UiRuntime((event) => events.push(event))
  const render = (next = node) =>
    runtime.render(next, width, height, theme, (ls, w) => renderViewLines(ls, theme, w))
  render()
  const click = (x: number, y: number) => {
    runtime.handleInput(mouse("press", x, y))
    return runtime.handleInput(mouse("release", x, y))
  }
  return { runtime, events, render, click }
}

test("tree clicks select on matching left release, survive redraw and double-activate stable keys", () => {
  const node: UiNode = { type: "tree", id: "tree", items: [item("first"), item("second")] }
  const s = setup(node)
  s.runtime.handleInput(mouse("release", 8, 1))
  for (const button of ["right", "middle"] as const) {
    s.runtime.handleInput(mouse("press", 8, 1, button))
    s.runtime.handleInput(mouse("release", 8, 1, button))
  }
  s.runtime.handleInput(mouse("drag", 8, 1))
  expect(s.events).toEqual([])
  s.runtime.handleInput(mouse("press", 8, 1))
  expect(s.runtime.state.selected.tree).toBe("first")
  s.render()
  s.runtime.handleInput(mouse("release", 8, 1))
  expect(s.events).toEqual([{ type: "select", id: "tree", key: "second" }])
  s.click(9, 1)
  expect(s.events.at(-1)).toEqual({ type: "activate", id: "tree", key: "second" })
  s.runtime.handleInput(mouse("press", 8, 0))
  s.runtime.handleInput(mouse("release", 8, 1))
  expect(s.events).toHaveLength(3)
  s.runtime.handleInput(mouse("press", 8, 1))
  s.render({ ...node, items: [item("second"), item("first")] })
  s.runtime.handleInput(mouse("release", 8, 1))
  expect(s.events).toHaveLength(3)
})

test("nested tree disclosure slots toggle without activating and details are not row targets", () => {
  const parent = {
    ...item("parent", [item("child")]),
    lead: [{ kind: "text" as const, text: "T" }],
    detail: [{ kind: "text" as const, text: "Details" }],
  }
  const s = setup({
    type: "box",
    child: { type: "tree", id: "tree", items: [parent, item("last")], expanded: "all" },
  })
  // Border + marker + shared two-cell lead puts disclosure at x=5.
  s.click(5, 1)
  expect(s.events.at(-1)).toEqual({ type: "toggle", id: "tree", key: "parent", expanded: false })
  s.click(5, 1)
  expect(s.events.at(-1)).toEqual({ type: "toggle", id: "tree", key: "parent", expanded: true })
  expect(s.events.some((e) => e.type === "activate")).toBe(false)
  const count = s.events.length
  s.click(10, 2)
  expect(s.events).toHaveLength(count)
  s.click(12, 3)
  expect(s.runtime.state.selected.tree).toBe("child")
  expect(s.events.at(-1)).toEqual({ type: "select", id: "tree", key: "child" })
  s.render()
  expect(s.runtime.state.expanded.tree).toEqual(["parent"])
})

test("tree hit rows account for scroll, detail heights and wheel changes before redraw", () => {
  const s = setup(
    { type: "tree", id: "tree", items: Array.from({ length: 10 }, (_, i) => item(`row-${i}`)) },
    20,
    3,
  )
  s.runtime.handleInput(mouse("wheel", 5, 1, "down"))
  expect(s.runtime.state.scroll.tree!.top).toBe(3)
  s.click(8, 0)
  expect(s.events.at(-1)).toEqual({ type: "select", id: "tree", key: "row-3" })
})

for (const theme of [monoTheme, defaultTheme]) {
  for (const style of ["brackets", "divided"] as const) {
    test(`${style} tab labels are clipped click targets in ${theme === monoTheme ? "mono" : "color"}`, () => {
      const s = setup(
        {
          type: "tabs",
          id: "tabs",
          style,
          tabs: [
            { key: "first", label: "First", body: text("body") },
            { key: "second", label: "Second", body: { type: "button", id: "hidden", label: "Hidden" } },
          ],
        },
        30,
        4,
        theme,
      )
      const line = stripAnsi(s.render()[0]!)
      s.click(line.indexOf("Second") + 1, 0)
      expect(s.runtime.state.activeTabs.tabs).toBe("second")
      expect(s.events.at(-1)).toEqual({ type: "tab", id: "tabs", key: "second" })
      expect(s.runtime.state.focused).toBe("tabs")
      // The inactive body's button did not accept the first tab's body click.
      const fresh = setup(
        {
          type: "tabs",
          id: "tabs",
          style,
          tabs: [
            { key: "first", label: "First", body: text() },
            { key: "second", label: "Second", body: { type: "button", id: "hidden", label: "Hidden" } },
          ],
        },
        17,
        4,
        theme,
      )
      fresh.click(3, 1)
      expect(fresh.events).toEqual([])
      fresh.click(16, 0)
      expect(fresh.events.at(-1)).toEqual({ type: "tab", id: "tabs", key: "second" })
    })
  }
}

test("identified tables select visible row keys, headers only focus; anonymous tables stay display-only", () => {
  const table: UiNode = {
    type: "table",
    id: "table",
    columns: [{ key: "name", label: "Name" }],
    rows: Array.from({ length: 8 }, (_, i) => ({ key: `key-${i}`, cells: { name: `Row ${i}` } })),
  }
  const s = setup(table, 20, 3)
  s.runtime.setState({ scroll: { table: { top: 3, following: false } } })
  s.click(5, 0)
  expect(s.events).toEqual([])
  s.click(5, 2)
  expect(s.events.at(-1)).toEqual({ type: "select", id: "table", key: "key-4" })
  s.click(6, 2)
  expect(s.events.at(-1)).toEqual({ type: "activate", id: "table", key: "key-4" })
  s.render({ ...table, id: undefined })
  expect(s.click(5, 1)).toBe(false)
  expect(s.events).toHaveLength(3)
})

test("text click focuses its scroll widget; wheel alone preserves focus and selection", () => {
  const s = setup({
    type: "row",
    children: [
      { node: { type: "button", id: "action", label: "Action" } },
      {
        node: {
          type: "text",
          id: "reading",
          lines: Array.from({ length: 20 }, (_, i) => ({ kind: "text", text: `${i}` })),
        },
      },
    ],
  })
  s.runtime.handleInput(mouse("wheel", 20, 1, "down"))
  expect(s.runtime.state.focused).toBe("action")
  expect(s.runtime.state.scroll.reading!.top).toBe(3)
  s.click(20, 1)
  expect(s.runtime.state.focused).toBe("reading")
  s.runtime.handleInput(key("pagedown"))
  expect(s.runtime.state.scroll.reading!.top).toBe(9)
  expect(s.events).toEqual([])
})

test("input clicks focus opt-in input and place caret in rendered cells, not hint or wide grapheme units", () => {
  const s = setup({ type: "box", child: { type: "input", id: "input", activate: "/", hint: "Hint" } }, 24, 4)
  s.runtime.setState({ inputValues: { input: "a界bc" } })
  s.render()
  expect(s.runtime.typing).toBe(false)
  s.click(6, 1) // Border + marker + three cells: after a界.
  expect(s.runtime.typing).toBe(true)
  s.runtime.handleInput(textKey("X"))
  expect(s.runtime.state.inputValues.input).toBe("a界Xbc")
  s.runtime.handleInput(key("escape"))
  expect(s.runtime.typing).toBe(false)
  const long = "abcdefghijklmnopqrstuvwxyz"
  s.runtime.setState({ inputValues: { input: long }, focused: "input" })
  s.render()
  s.click(3, 1) // First cell of the horizontally scrolled editor.
  s.runtime.handleInput(textKey("!"))
  expect(s.runtime.state.inputValues.input).not.toBe(`!${long}`)
  expect(s.runtime.state.inputValues.input).not.toBe(`${long}!`)
})

test("button labels are sanitized, focusable and activate by Enter, Space and click with key fallback", () => {
  const s = setup(
    {
      type: "column",
      children: [
        { size: 1, node: text("reading") },
        { node: { type: "button", id: "run", label: "Run\u001b[31m", key: "execute", tone: "accent" } },
      ],
    },
    20,
    4,
  )
  expect(s.runtime.selectable).toBe(true)
  expect(stripAnsi(s.render()[1]!)).toContain("[Run]")
  s.runtime.handleInput(key("tab"))
  expect(s.runtime.state.focused).toBe("run")
  s.runtime.handleInput(key("enter"))
  s.runtime.handleInput(textKey(" "))
  expect(s.click(3, 1)).toBe(true)
  expect(s.events).toEqual(Array.from({ length: 3 }, () => ({ type: "activate", id: "run", key: "execute" })))
  s.click(3, 2) // Blank allocated rows are not button targets.
  expect(s.events).toHaveLength(3)
  s.render({ type: "button", id: "fallback", label: "Go" })
  s.runtime.handleInput(key("space"))
  expect(s.events.at(-1)).toEqual({ type: "activate", id: "fallback", key: "fallback" })
})

test("clearFrame and dispose cancel pending clicks and remove invisible targets", () => {
  const node: UiNode = { type: "button", id: "button", label: "Go" }
  for (const clear of ["clearFrame", "dispose"] as const) {
    const s = setup(node)
    s.runtime.handleInput(mouse("press", 3, 0))
    s.runtime[clear]()
    expect(s.runtime.handleInput(mouse("release", 3, 0))).toBe(false)
    s.render()
    s.runtime.handleInput(mouse("release", 3, 0))
    expect(s.events).toEqual([])
  }
})
