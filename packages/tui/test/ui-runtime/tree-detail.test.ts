import { expect, test } from "bun:test"
import type { UiEvent, UiNode, UiTreeItem, ViewSegment } from "@amira/api"
import { key, monoTheme, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { wrapViewLines } from "../../src/extension-view.ts"
import { UiRuntime } from "../../src/ui-runtime/runtime.ts"
import { renderViewLines } from "../../src/view-lines.ts"

const parts = (text: string): ViewSegment[] => [{ kind: "text", text }]
const text = (s: string, id?: string): UiNode => ({ type: "text", id, lines: [{ kind: "text", text: s }] })
function setup(items: UiTreeItem[], width = 36, height = 20) {
  const events: UiEvent[] = []
  const runtime = new UiRuntime((e) => events.push(e))
  const node: UiNode = { type: "tree", id: "tree", items }
  const render = (w = width, h = height) =>
    runtime
      .render(node, w, h, monoTheme, (ls, size) => renderViewLines(wrapViewLines(ls, size), monoTheme, size))
      .map(stripAnsi)
  const press = (name: string) => runtime.handleInput(key(name))
  render()
  return { runtime, events, render, press }
}

const card: UiNode = {
  type: "box",
  title: "Worker",
  aside: "running",
  border: "round",
  tone: "accent",
  child: {
    type: "column",
    children: [
      {
        node: {
          type: "row",
          gap: 1,
          children: [
            { size: 8, node: text("Task", "ignored-text") },
            { node: { type: "bar", left: parts("Update"), right: parts("API") } },
          ],
        },
      },
      { node: { type: "progress", value: 0.5, width: 4 } },
      { node: { type: "rule", label: "Files" } },
      {
        node: {
          type: "table",
          id: "ignored-table",
          columns: [{ key: "f", label: "Path" }],
          rows: [{ key: "file-key", cells: { f: "events.ts" } }],
        },
      },
    ],
  },
}

test("widget details render under the expanded tree row at the width after rails/indent", () => {
  const s = setup([
    {
      key: "phase",
      row: parts("Phase"),
      rail: true,
      children: [{ key: "worker", row: parts("Worker"), rail: true, detail: card }],
    },
  ])
  expect(s.render().join("\n")).not.toContain("events.ts")
  s.press("right")
  s.press("down")
  expect(s.render().join("\n")).not.toContain("events.ts")
  s.press("right")
  const lines = s.render()
  expect(lines[2]).toStartWith("    │ ╭ Worker")
  expect(lines[2]).toEndWith("running ╮")
  expect(lines[3]).toContain("Task     Update")
  expect(lines[4]).toContain("━━── 50%")
  expect(lines[5]).toContain(" Files ")
  expect(lines[6]).toContain("Path")
  expect(lines[7]).toContain("events.ts")
  expect(lines[8]).toStartWith("    │ ╰")
  expect(lines.every((line) => visibleWidth(line) === 36)).toBe(true)
  s.press("tab")
  expect(s.runtime.state.focused).toBe("tree")
  s.press("enter")
  expect(s.events.at(-1)).toEqual({ type: "activate", id: "tree", key: "worker" })
  expect(s.runtime.state.selected).toEqual({ tree: "worker" })
  expect(Object.keys(s.runtime.state.scroll)).toEqual(["tree"])
  s.press("left")
  expect(s.render().join("\n")).not.toContain("events.ts")
})

test("detail IDs, follow and unsupported interactive widgets cannot own focus, state or wheel", () => {
  const s = setup(
    [
      {
        key: "item",
        row: parts("Item"),
        detail: {
          type: "column",
          children: [
            {
              node: {
                type: "text",
                id: "nested",
                follow: true,
                lines: Array.from({ length: 8 }, (_, i) => ({ kind: "text", text: `line ${i}` })),
              },
            },
            { node: { type: "input", id: "input", placeholder: "SECRET input" } },
            {
              node: {
                type: "tabs",
                id: "tabs",
                tabs: [{ key: "a", label: "SECRET tab", body: text("SECRET body") }],
              },
            },
            {
              node: {
                type: "tree",
                id: "nested-tree",
                items: [{ key: "nested-item", row: parts("SECRET tree") }],
              },
            },
          ],
        },
      },
      { key: "next", row: parts("Next") },
    ],
    30,
    4,
  )
  s.press("right")
  expect(s.render()[1]).toContain("line 0")
  expect(s.render().join("\n")).not.toContain("SECRET")
  s.runtime.handleInput({
    type: "mouse",
    action: "wheel",
    button: "down",
    x: 8,
    y: 2,
    ctrl: false,
    alt: false,
    shift: false,
  })
  expect(s.runtime.state.scroll.tree?.top).toBe(3)
  expect(s.render()[0]).toContain("line 2")
  expect(s.runtime.state.focused).toBe("tree")
  expect(s.runtime.state.activeTabs).toEqual({})
  expect(s.runtime.state.inputValues).toEqual({})
  expect(Object.keys(s.runtime.state.scroll)).toEqual(["tree"])
  s.press("down")
  s.press("enter")
  expect(s.events.slice(-2)).toEqual([
    { type: "select", id: "tree", key: "next" },
    { type: "activate", id: "tree", key: "next" },
  ])
})

test("timeline lead is a shared cell-width column, nodes replace disclosure, underlines continue rails", () => {
  const s = setup(
    [
      {
        key: "a",
        lead: parts("10:12:31 ✓"),
        node: parts("○"),
        row: parts("Plan"),
        rail: true,
        underline: true,
      },
      {
        key: "b",
        lead: parts("界 ✓"),
        node: parts("◉"),
        row: parts("Build"),
        rail: true,
        underline: true,
        detail: text("Body"),
      },
      { key: "c", node: parts("○"), row: parts("Done"), underline: true },
    ],
    30,
    9,
  )
  s.press("down")
  s.press("right")
  const lines = s.render()
  expect(lines[0]).toBe("» 10:12:31 ✓ ○ Plan".padEnd(30))
  expect(lines[1]).toBe("             │ ───────────────")
  expect(lines[2]).toBe("❯ 界 ✓       ◉ Build".padEnd(29)) // 界 occupies two cells.
  expect(lines[3]).toBe("             │ Body".padEnd(30))
  expect(lines[4]).toBe(lines[1])
  expect(lines[5]).toBe("             ○ Done".padEnd(30))
  expect(lines[6]).toBe("               ───────────────")
  s.press("left")
  expect(s.render()[3]).toBe(lines[1])
})

test("widget details retain exact viewport slices across borders, rows, dividers, text and tables", () => {
  const detail: UiNode = {
    type: "box",
    title: "Outer",
    child: {
      type: "column",
      gap: 1,
      divider: true,
      children: [
        { node: card },
        {
          node: {
            type: "row",
            divider: true,
            children: [
              { node: text("one\ntwo\nthree") },
              { node: { type: "box", title: "Inner", child: text("hello") } },
            ],
          },
        },
        { size: 3, node: { type: "progress", value: 1 } },
      ],
    },
  }
  const s = setup(
    [
      { key: "a", row: parts("A"), rail: true, underline: true, detail },
      { key: "b", row: parts("B") },
    ],
    50,
    50,
  )
  s.press("right")
  const full = s.render().map((line) => line.slice(2))
  for (let top = 0; top < 20; top++) {
    s.runtime.setState({ scroll: { tree: { top, following: false } } })
    const cropped = s.render(50, 3).map((line) => line.slice(2))
    const actual = s.runtime.state.scroll.tree!.top
    expect(cropped).toEqual(full.slice(actual, actual + 3))
  }
})

test("legacy line details and timeline styling coexist, sanitize segments, and resize safely", () => {
  const dirty = "old\r\x1b[31msafe\x1b[0m\x1b]0;injected\x07"
  const s = setup([
    {
      key: "a",
      row: parts("A"),
      lead: parts(dirty),
      node: parts("○\x1b[2J"),
      rail: true,
      underline: true,
      detail: [{ kind: "text", text: "Legacy" }],
    },
  ])
  s.press("right")
  expect(s.render().join("\n")).toContain("Legacy")
  expect(s.render()[0]).toContain("safe")
  expect(s.render().join("\n")).not.toContain("injected")
  for (const w of [0, 1, 2, 4, 8, 20, 80]) {
    const rows = s.render(w, 5)
    expect(rows).toHaveLength(w ? 5 : 0)
    expect(rows.every((line) => visibleWidth(line) <= w)).toBe(true)
  }
})

test("detail sizing uses wrapped content, row widths, column minima, and fixed heights", () => {
  const detail: UiNode = {
    type: "box",
    border: "none",
    child: {
      type: "column",
      children: [
        {
          size: "50%",
          node: {
            type: "row",
            children: [{ node: { type: "spacer", size: 3 } }, { node: text("a".repeat(20)) }],
          },
        },
        { size: 1, min: 2, node: text("Fixed") },
        { node: text("Last") },
      ],
    },
  }
  const s = setup(
    [
      { key: "a", row: parts("A"), detail },
      { key: "b", row: parts("B") },
    ],
    17,
    12,
  )
  s.press("right")
  const lines = s.render()
  expect(lines[1]?.trim()).toBe("aaaaaaaaaa")
  expect(lines[2]?.trim()).toBe("aaaaaaaaaa")
  expect(lines[3]?.trim()).toBe("Fixed")
  expect(lines[4]?.trim()).toBe("")
  expect(lines[5]?.trim()).toBe("Last")
  expect(lines[6]?.trim()).toBe("B")
  expect(s.render(27)[2]?.trim()).toBe("Fixed")
})

test("an empty bordered widget detail still displays its title and aside", () => {
  const s = setup([
    {
      key: "a",
      row: parts("A"),
      detail: { type: "box", title: "Worker", aside: "queued", child: { type: "text", lines: [] } },
    },
  ])
  s.press("right")
  const lines = s.render()
  expect(lines[1]).toContain("╭ Worker")
  expect(lines[1]).toContain("queued ╮")
  expect(lines[3]).toContain("╰")
})

test("a tall widget table paints only cells within the tree viewport", () => {
  let paints = 0
  const detail: UiNode = {
    type: "box",
    title: "Files",
    child: {
      type: "table",
      columns: [{ key: "file", label: "File" }],
      rows: Array.from({ length: 500 }, (_, i) => ({
        key: String(i),
        cells: {
          get file() {
            paints++
            return `File ${i}`
          },
        },
      })),
    },
  }
  const s = setup([{ key: "a", row: parts("A"), detail }], 40, 5)
  s.press("right")
  s.runtime.setState({ scroll: { tree: { top: 100, following: false } } })
  const lines = s.render()
  expect(paints).toBe(5)
  expect(lines[0]).toContain("File 97")
  expect(lines[4]).toContain("File 101")
})

test("collapsed widget details are never measured and offscreen details are never painted", () => {
  let painted = 0
  const detail: UiNode = {
    type: "bar",
    get left() {
      painted++
      return parts("Hidden")
    },
  }
  const s = setup(
    [
      { key: "a", row: parts("A") },
      { key: "b", row: parts("B"), detail },
      {
        key: "c",
        row: parts("C"),
        detail: {
          type: "text",
          get lines(): never {
            throw new Error("collapsed")
          },
        },
      },
    ],
    30,
    1,
  )
  s.runtime.setState({ expanded: { tree: ["b"] } })
  s.render()
  expect(painted).toBe(0)
  s.press("down")
  s.press("down")
  expect(s.runtime.state.selected.tree).toBe("c")
})
