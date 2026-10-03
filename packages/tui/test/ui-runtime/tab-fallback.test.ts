import { expect, test } from "bun:test"
import type { UiEvent, UiNode, UiState, ViewDefinition, ViewKeyName } from "@amira/api"
import { key, monoTheme } from "@amira/tui-kit"
import { ExtensionViewer } from "../../src/extension-view.ts"

const context = { theme: monoTheme, color: false, rows: 12 }
const staticNode: UiNode = { type: "text", lines: [{ kind: "text", text: "Static content" }] }

function setup(keys: ViewKeyName[], node: UiNode = staticNode) {
  let state!: UiState
  let legacyCalls = 0
  const events: UiEvent[] = []
  const definition: ViewDefinition = {
    kind: "tab-fallback",
    title: () => "Tab fallback",
    keys: keys.map((key) => ({ key, label: "", run: () => legacyCalls++ })),
    ui: (_data, ctx) => {
      state = ctx.state
      return node
    },
    onEvent: (event) => events.push(event),
  }
  const viewer = new ExtensionViewer(definition, {})
  viewer.render(40, context)
  return {
    viewer,
    events,
    get state() {
      return state
    },
    get legacyCalls() {
      return legacyCalls
    },
  }
}

for (const shift of [false, true]) {
  test(`a view without focusable widgets forwards declared ${shift ? "Shift+Tab" : "Tab"}`, () => {
    const h = setup(["tab", "shift-tab"])
    expect(h.viewer.handleInput(key("tab", { shift }))).toBe(true)
    expect(h.events).toEqual([{ type: "key", key: shift ? "shift-tab" : "tab", focused: undefined }])
    expect(h.legacyCalls).toBe(0)
  })

  test(`a view without focusable widgets leaves undeclared ${shift ? "Shift+Tab" : "Tab"} unhandled`, () => {
    for (const keys of [[], [shift ? "tab" : "shift-tab"]]) {
      const h = setup(keys)
      expect(h.viewer.handleInput(key("tab", { shift }))).toBe(false)
      expect(h.events).toEqual([])
      expect(h.legacyCalls).toBe(0)
    }
  })
}

for (const ids of [["only"], ["first", "middle", "last"]]) {
  test(`${ids.length} focusable widgets retain Tab traversal ahead of declared keys`, () => {
    const h = setup(["tab", "shift-tab"], {
      type: "column",
      children: [
        { size: 0, node: { type: "input", id: "hidden" } },
        { size: 1, node: staticNode },
        ...ids.map((id) => ({ size: 1, node: { type: "input" as const, id } })),
      ],
    })
    expect(h.state.focused).toBe(ids[0])
    for (const expected of [...ids.slice(1), ids[0]]) {
      expect(h.viewer.handleInput(key("tab"))).toBe(true)
      expect(h.state.focused).toBe(expected)
    }
    for (const expected of [...ids.slice(1).reverse(), ids[0]]) {
      expect(h.viewer.handleInput(key("tab", { shift: true }))).toBe(true)
      expect(h.state.focused).toBe(expected)
    }
    expect(h.events).toEqual([])
    expect(h.legacyCalls).toBe(0)
  })
}
