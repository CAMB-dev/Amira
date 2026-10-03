import { expect, test } from "bun:test"
import type { UiEvent, UiNode, UiTreeItem } from "@amira/api"
import { CURSOR_MARKER, defaultTheme, key, monoTheme, stripAnsi, textKey, visibleWidth } from "@amira/tui-kit"
import { terminalText } from "../../src/diff-view.ts"
import { wrapViewLines } from "../../src/extension-view.ts"
import { allocate } from "../../src/ui-runtime/layout.ts"
import { UiRuntime } from "../../src/ui-runtime/runtime.ts"
import { renderViewLines } from "../../src/view-lines.ts"

const text = (label: string, id?: string): UiNode => ({
  type: "text",
  id,
  lines: [{ kind: "text", text: label }],
})
const item = (key: string, children?: UiTreeItem[]): UiTreeItem => ({
  key,
  row: [{ kind: "text", text: key }],
  children,
})
const tree: UiNode = {
  type: "tree",
  id: "tree",
  items: [item("parent", [item("child", [item("grandchild")])]), item("next")],
}

function setup(node: UiNode, width = 40, height = 10) {
  const events: UiEvent[] = []
  const runtime = new UiRuntime((event) => events.push(event))
  const render = (next = node, w = width, h = height) =>
    runtime.render(next, w, h, monoTheme, (ls, size) =>
      renderViewLines(wrapViewLines(ls, size), monoTheme, size),
    )
  render()
  return {
    runtime,
    events,
    render,
    plain: () => render().map(stripAnsi),
    press: (name: string) => runtime.handleInput(key(name)),
  }
}

test("allocation resolves fixed, percent, fill, minima, gap and divider budgets", () => {
  expect(allocate(20, [{ size: 4 }, { size: "25%" }, { size: "fill" }])).toEqual([4, 5, 11])
  expect(allocate(20, [{ size: 4 }, { size: "50%" }, {}], 1, true)).toEqual([4, 8, 4])
  expect(allocate(20, [{ size: 2, min: 6 }, { min: 4 }, {}])).toEqual([6, 9, 5])
  expect(allocate(7, [{}, {}, {}])).toEqual([3, 2, 2])
  expect(
    allocate(5, [
      { size: 10, min: 8 },
      { size: 10, min: 8 },
    ]),
  ).toEqual([3, 2])
  expect(allocate(1, [{ min: 4 }, { min: 4 }], 4, true)).toEqual([0, 0])
  expect(allocate(8, [{ size: Number.NaN }, { size: -9 }, {}])).toEqual([0, 0, 8])
  expect(allocate(9, [])).toEqual([])
})

test("row and column dividers cost a cell in addition to gap; spacers supply default size", () => {
  const s = setup(
    {
      type: "row",
      gap: 1,
      divider: true,
      children: [{ size: 3, node: text("abc") }, { node: text("rest") }],
    },
    10,
    2,
  )
  expect(s.plain()[0]).toBe("abc│ rest ")
  expect(
    s
      .render(
        {
          type: "column",
          gap: 1,
          divider: true,
          children: [{ size: 1, node: text("abc") }, { node: text("rest") }],
        },
        8,
        4,
      )
      .map(stripAnsi),
  ).toEqual(["abc     ", "────────", "        ", "rest    "])
  expect(
    s
      .render({ type: "row", children: [{ node: { type: "spacer", size: 3 } }, { node: text("x") }] }, 8, 1)
      .map(stripAnsi),
  ).toEqual(["   x    "])
})

test("tiny rectangles suppress borders, clip safely and omit hidden focus targets", () => {
  const node: UiNode = { type: "box", title: "Title", child: text("内容 too long", "body") }
  const s = setup(node)
  for (const [width, height] of [
    [1, 1],
    [4, 2],
    [8, 2],
    [0, 0],
    [80, 24],
  ]) {
    const lines = s.render(node, width, height)
    expect(lines).toHaveLength(height!)
    expect(lines.every((l) => visibleWidth(l) <= width!)).toBe(true)
    if (width! < 8 || height! < 3) expect(lines.join("")).not.toContain("╭")
  }
  s.render({
    type: "column",
    children: [{ size: 0, node: text("hidden", "hidden") }, { node: text("visible", "visible") }],
  })
  expect(s.runtime.state.focused).toBe("visible")
})

test("focus traverses visible widgets and only the active tab body", () => {
  const s = setup(
    {
      type: "column",
      children: [
        { node: tree },
        {
          node: {
            type: "tabs",
            id: "tabs",
            tabs: [
              { key: "a", label: "A", body: text("A", "a") },
              { key: "b", label: "B", body: { type: "input", id: "b" } },
            ],
          },
        },
        { node: { type: "input", id: "input" } },
        { node: text("static") },
      ],
    },
    40,
    20,
  )
  expect(s.runtime.state.focused).toBe("tree")
  s.press("tab")
  expect(s.runtime.state.focused).toBe("tabs")
  s.press("tab")
  expect(s.runtime.state.focused).toBe("a")
  s.press("tab")
  expect(s.runtime.state.focused).toBe("input")
  s.runtime.handleInput(key("tab", { shift: true }))
  expect(s.runtime.state.focused).toBe("a")
  s.runtime.focus("tabs")
  s.press("right")
  s.press("tab") // No intervening render: stale tab bodies must not take focus.
  expect(s.runtime.state.focused).toBe("b")
  expect(s.events.at(-1)).toEqual({ type: "tab", id: "tabs", key: "b" })
  s.runtime.focus("missing")
  s.render()
  expect(s.runtime.state.focused).toBe("tree")
})

test("tree expands, selects, activates, collapses and moves to parent before redraw", () => {
  const s = setup(tree)
  s.press("right")
  s.press("down")
  expect(s.runtime.state.selected.tree).toBe("child")
  s.press("right")
  s.press("down")
  expect(s.runtime.state.selected.tree).toBe("grandchild")
  s.press("left")
  expect(s.runtime.state.selected.tree).toBe("child")
  s.press("left")
  expect(s.runtime.state.expanded.tree).toEqual(["parent"])
  s.press("enter")
  s.press("left")
  s.press("left")
  s.press("down")
  expect(s.runtime.state.selected.tree).toBe("next")
  expect(s.events).toContainEqual({ type: "activate", id: "tree", key: "child" })
  expect(s.events).toContainEqual({ type: "toggle", id: "tree", key: "parent", expanded: false })
  expect(s.events.flatMap((e) => (e.type === "select" ? [e.key] : []))).toEqual([
    "child",
    "grandchild",
    "child",
    "parent",
    "next",
  ])
})

test("tree details and expandable lazy rows work without visiting collapsed descendants", () => {
  const lazy: UiTreeItem = { ...item("lazy"), expandable: true, detail: [{ kind: "text", text: "Detail" }] }
  const hidden: UiTreeItem = {
    key: "hidden",
    get row(): never {
      throw new Error("must not paint")
    },
    get detail(): never {
      throw new Error("must not prepare")
    },
  }
  const s = setup({ type: "tree", id: "t", items: [lazy, item("closed", [hidden])] })
  expect(s.plain().join("\n")).not.toContain("Detail")
  s.press("right")
  expect(s.plain().join("\n")).toContain("Detail")
  expect(s.events[0]).toEqual({ type: "toggle", id: "t", key: "lazy", expanded: true })
})

test("state patches replace supplied maps and override defaults after event dispatch", () => {
  let runtime!: UiRuntime
  runtime = new UiRuntime((event) => {
    if (event.type === "select") {
      expect(runtime.state.selected.tree).toBe("next")
      runtime.setState({ selected: { tree: "parent" }, focused: "tree" })
    }
  })
  runtime.render(tree, 40, 10, monoTheme, (ls, w) => renderViewLines(ls, monoTheme, w))
  runtime.handleInput(key("down"))
  expect(runtime.state.selected.tree).toBe("parent")
  runtime.setState({ inputValues: { a: "one", b: "two" } })
  runtime.setState({ inputValues: { a: "three" } })
  expect(runtime.state.inputValues).toEqual({ a: "three" })
})

test("same-ID replacements retain state and removed selections reconcile deterministically", () => {
  const s = setup(tree)
  s.press("right")
  s.press("down")
  s.render({ type: "tree", id: "tree", items: [item("parent", [item("child")]), item("new")] })
  expect(s.runtime.state.selected.tree).toBe("child")
  expect(s.runtime.state.expanded.tree).toEqual(["parent"])
  s.render({ type: "tree", id: "tree", items: [item("replacement")] })
  expect(s.runtime.state.selected.tree).toBe("replacement")
  s.runtime.dispose()
  expect(s.runtime.state.selected).toEqual({})
  expect(s.runtime.state.focused).toBeUndefined()
})

test("input editing preserves caret on rerenders, sanitizes patches/pastes and submits", () => {
  const s = setup({ type: "input", id: "input", placeholder: "Example", hint: "Enter send" })
  s.runtime.handleInput({ type: "paste", text: "abc" })
  s.press("left")
  s.render()
  s.runtime.handleInput(textKey("X"))
  expect(s.runtime.state.inputValues.input).toBe("abXc")
  s.press("enter")
  expect(s.events.at(-1)).toEqual({ type: "submit", id: "input", value: "abXc" })
  s.runtime.setState({ inputValues: { input: "bad\r\x1b[31mclean\x1b[0m" } })
  expect(stripAnsi(s.render()[0]!)).toContain("clean")
  expect(s.runtime.state.inputValues.input).toBe("clean")
  s.runtime.handleInput({ type: "paste", text: "\x1b[2Jz\b!\nline" })
  expect(s.runtime.state.inputValues.input).toBe("clean! line")
  expect(s.render().join("")).toContain(CURSOR_MARKER)
})

test("table uses shared column widths and right alignment; identified rows select/activate", () => {
  const node: UiNode = {
    type: "table",
    id: "table",
    columns: [
      { key: "name", label: "Name" },
      { key: "count", label: "Count", size: 5, align: "right" },
    ],
    rows: [
      { key: "a", cells: { name: "alpha", count: "2" } },
      { key: "b", cells: { name: "beta", count: [{ kind: "success", text: "42" }] } },
    ],
  }
  const s = setup(node, 20, 5)
  expect(s.plain().slice(0, 3)).toEqual([
    "❯ Name         Count",
    "❯ alpha            2",
    "  beta            42",
  ])
  s.press("down")
  s.press("enter")
  expect(s.events).toEqual([
    { type: "select", id: "table", key: "b" },
    { type: "activate", id: "table", key: "b" },
  ])
})

test("focused scrollables own paging and wheel hits a different widget without changing focus", () => {
  const log = (id: string): UiNode => ({
    type: "text",
    id,
    lines: Array.from({ length: 30 }, (_, i) => ({ kind: "text", text: `${id} ${i}` })),
  })
  const s = setup(
    { type: "row", divider: true, children: [{ node: log("left") }, { node: log("right") }] },
    41,
    5,
  )
  s.press("pagedown")
  expect(s.runtime.state.scroll.left?.top).toBe(5)
  s.runtime.handleInput({
    type: "mouse",
    action: "wheel",
    button: "down",
    x: 25,
    y: 2,
    shift: false,
    ctrl: false,
    alt: false,
  })
  expect(s.runtime.state.scroll.right?.top).toBe(3)
  expect(s.runtime.state.focused).toBe("left")
  s.press("end")
  expect(s.runtime.state.scroll.left).toEqual({ top: 25, following: true })
  s.press("home")
  expect(s.runtime.state.scroll.left).toEqual({ top: 0, following: false })
})

test("text follows growth until scrolled up and inactive tab scroll survives", () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({ kind: "text" as const, text: String(i) }))
  const node: UiNode = {
    type: "tabs",
    id: "tabs",
    tabs: [
      { key: "a", label: "A", body: { type: "text", id: "log", follow: true, lines } },
      { key: "b", label: "B", body: text("B") },
    ],
  }
  const s = setup(node, 20, 5)
  expect(s.runtime.state.scroll.log?.top).toBe(16)
  s.runtime.focus("log")
  s.press("up")
  lines.push({ kind: "text", text: "20" })
  s.render()
  expect(s.runtime.state.scroll.log).toEqual({ top: 15, following: false })
  s.runtime.focus("tabs")
  s.press("right")
  s.render()
  s.press("left")
  s.render()
  expect(s.runtime.state.scroll.log?.top).toBe(15)
})

test("all string-bearing widgets use existing terminalText semantics before styling", () => {
  const dirty = "gone\r\x1b[31mclean\b!\x1b[0m\tend\nrow\x1b]0;injected\x07"
  const clean = terminalText(dirty)
  const seg = [{ kind: "text" as const, text: dirty }]
  const nodes: UiNode[] = [
    { type: "box", title: dirty, aside: dirty, child: { type: "spacer" } },
    { type: "box", title: { kind: "segments", parts: seg }, child: { type: "spacer" } },
    text(dirty),
    {
      type: "tree",
      id: "tree",
      items: [{ key: "x", row: seg, aside: seg, detail: [{ kind: "text", text: dirty }] }],
    },
    { type: "tabs", id: "tabs", tabs: [{ key: "x", label: dirty, body: text("body") }] },
    {
      type: "table",
      columns: [
        { key: "x", label: dirty },
        { key: "y", label: dirty },
      ],
      rows: [{ key: "x", cells: { x: dirty, y: seg } }],
    },
    { type: "bar", left: seg, right: seg },
    { type: "progress", value: 0.5, label: dirty },
    { type: "rule", label: dirty },
    { type: "input", id: "input", placeholder: dirty, hint: dirty },
  ]
  for (const node of nodes) {
    const s = setup(node, 120, 8)
    s.runtime.setState({ expanded: { tree: ["x"] } })
    const output = s.render().map(stripAnsi).join("\n")
    expect(output).toContain(clean)
    expect(output).not.toContain("gone")
    expect(output).not.toContain("injected")
    expect(output).not.toContain("\x1b")
    expect(output).not.toContain("\r")
  }
})

test("styled siblings cannot leak colors and progress clamps invalid values", () => {
  const runtime = new UiRuntime(() => {})
  const node: UiNode = {
    type: "row",
    children: [
      { node: { type: "bar", left: [{ kind: "error", text: "long text here" }] } },
      { node: { type: "progress", value: 9, width: 4 } },
    ],
  }
  const rows = runtime.render(node, 20, 1, defaultTheme, (ls, w) => renderViewLines(ls, defaultTheme, w))
  expect(visibleWidth(rows[0]!)).toBe(20)
  expect(stripAnsi(rows[0]!)).toContain("100%")
  expect(stripAnsi(rows[0]!)).toContain("…")
})

test("percentage rounding retains the cell budget without fill children", () => {
  expect(allocate(5, [{ size: "50%" }, { size: "50%" }])).toEqual([3, 2])
  expect(allocate(10, [{ size: "100%" }, { size: "100%" }, { min: 5 }])).toEqual([3, 2, 5])
})

test("ID-less text and tables wheel-scroll without becoming focus targets", () => {
  const node: UiNode = {
    type: "table",
    columns: [{ key: "name", label: "Name" }],
    rows: Array.from({ length: 10 }, (_, i) => ({ key: String(i), cells: { name: `Row ${i}` } })),
  }
  const s = setup(node, 20, 4)
  s.runtime.handleInput({
    type: "mouse",
    action: "wheel",
    button: "down",
    x: 1,
    y: 2,
    ctrl: false,
    alt: false,
    shift: false,
  })
  expect(s.plain()[1]?.trim()).toBe("Row 3")
  expect(s.runtime.state.focused).toBeUndefined()
  expect(s.runtime.state.scroll).toEqual({})
})

test("narrow tab strips keep their active label visible and deleted tabs reconcile", () => {
  const tabs: UiNode = {
    type: "tabs",
    id: "tabs",
    tabs: [
      { key: "a", label: "Long first label", body: text("A") },
      { key: "b", label: "Second", body: text("B") },
    ],
  }
  const s = setup(tabs, 14, 3)
  s.press("right")
  expect(s.plain()[0]).toContain("[Second]")
  tabs.tabs.pop()
  s.render()
  expect(s.runtime.state.activeTabs.tabs).toBe("a")
})

test("focus remains visible when wheel scrolls a tree's selection out of view", () => {
  const s = setup(
    { type: "tree", id: "tree", items: Array.from({ length: 20 }, (_, i) => item(String(i))) },
    20,
    4,
  )
  s.runtime.handleInput({
    type: "mouse",
    action: "wheel",
    button: "down",
    x: 1,
    y: 2,
    ctrl: false,
    alt: false,
    shift: false,
  })
  expect(s.plain()[0]).toStartWith("» ")
  expect(s.runtime.state.selected.tree).toBe("0")
})

test("stable IDs and item keys cannot address object prototypes", () => {
  const s = setup({ type: "tree", id: "__proto__", items: [item("constructor")] })
  expect(Object.entries(s.runtime.state.selected)).toContainEqual(["__proto__", "constructor"])
  expect(s.runtime.state.focused).toBe("__proto__")
  s.runtime.setState({ inputValues: { constructor: "safe" } })
  s.render({ type: "input", id: "constructor" })
  expect(Object.entries(s.runtime.state.inputValues)).toContainEqual(["constructor", "safe"])
  expect(
    s
      .render({
        type: "table",
        columns: [{ key: "constructor", label: "Header" }],
        rows: [{ key: "row", cells: {} }],
      })
      .map(stripAnsi)[1]
      ?.trim(),
  ).toBe("")
  s.render({ type: "tree", id: "", items: [item("")] })
  s.press("enter")
  expect(s.events.at(-1)).toEqual({ type: "activate", id: "", key: "" })
})
