import { expect, test } from "bun:test"
import type { UiContext, UiControl, UiEvent, UiNode } from "@amira/api"
import { CURSOR_MARKER, key, monoTheme, stripAnsi, textKey, visibleWidth } from "@amira/tui-kit"
import { ExtensionViewer } from "../../src/extension-view.ts"

const input: UiNode = {
  type: "input",
  id: "ask",
  activate: "i",
  placeholder: "Ask Amira",
  hint: "Enter send",
}
const context = { theme: monoTheme, color: false, rows: 8 }

function host(node: UiNode = input) {
  let ctx!: UiContext
  let control!: UiControl
  let closed = 0
  let renders = 0
  const events: UiEvent[] = []
  const viewer = new ExtensionViewer(
    {
      kind: "activation",
      title: () => "Activation",
      hostKeys: "none",
      keys: [
        { key: "x", label: "act" },
        { key: "i", label: "fallback" },
      ],
      onOpen: (_data, view) => {
        control = view
      },
      ui: (_data, next) => {
        ctx = next
        return node
      },
      onEvent: (event) => events.push(event),
    },
    {},
    { onClose: () => closed++, requestRender: () => renders++ },
  )
  viewer.mount()
  const render = (width = 60) => viewer.render(width, context)
  render()
  return {
    viewer,
    control,
    events,
    render,
    get ctx() {
      return ctx
    },
    get closed() {
      return closed
    },
    get renders() {
      return renders
    },
  }
}

test("gated input starts idle, hints activation and lets declared keys reach the view", () => {
  const h = host()
  expect(h.ctx.state.focused).toBeUndefined()
  expect(h.render().join("\n")).not.toContain(CURSOR_MARKER)
  expect(h.render().map(stripAnsi).join("\n")).toContain("Ask Amira (i to type)")
  h.viewer.handleInput(textKey("x"))
  h.viewer.handleInput({ type: "paste", text: "not focused" })
  expect(h.events).toEqual([{ type: "key", key: "x", focused: undefined }])
  expect(h.ctx.state.inputValues.ask).toBe("")
  h.viewer.handleInput(key("i", { ctrl: true }))
  expect(h.ctx.state.focused).toBeUndefined()
  h.viewer.handleInput(textKey("i"))
  expect(h.ctx.state.focused).toBe("ask")
  expect(h.ctx.state.inputValues.ask).toBe("") // The activation key is not inserted or emitted.
  expect(h.events).toHaveLength(1)
  expect(h.render().join("\n")).toContain(CURSOR_MARKER)
  expect(h.render().map(stripAnsi).join("\n")).not.toContain("i to type")
  h.viewer.handleInput(textKey("q"))
  h.viewer.handleInput({ type: "paste", text: " draft" })
  h.viewer.handleInput(key("enter"))
  expect(h.events.at(-1)).toEqual({ type: "submit", id: "ask", value: "q draft" })
  expect(h.closed).toBe(0)
  const renders = h.renders
  h.viewer.handleInput(key("escape"))
  expect(h.renders).toBeGreaterThan(renders)
  expect(h.closed).toBe(0)
  expect(h.ctx.state.focused).toBeUndefined()
  h.render()
  h.viewer.handleInput(textKey("x"))
  expect(h.events.at(-1)).toEqual({ type: "key", key: "x", focused: undefined })
  h.viewer.handleInput(textKey("i"))
  h.viewer.handleInput(textKey("!"))
  expect(h.ctx.state.inputValues.ask).toBe("q draft!")
  h.viewer.handleInput(key("escape"))
  h.viewer.handleInput(key("escape")) // No render between escapes; second closes.
  expect(h.closed).toBe(1)
})

test("activation returns focus to the previous widget; Tab and explicit focus still allow typing", () => {
  const h = host({
    type: "column",
    children: [
      { size: 1, node: input },
      { node: { type: "text", id: "first", lines: [] } },
      { node: { type: "text", id: "second", lines: [] } },
    ],
  })
  expect(h.ctx.state.focused).toBe("first")
  h.control.focus("second")
  h.viewer.handleInput(textKey("i"))
  h.viewer.handleInput(key("escape"))
  expect(h.ctx.state.focused).toBe("second")
  h.viewer.handleInput(key("tab"))
  h.viewer.handleInput(textKey("a"))
  expect(h.ctx.state.inputValues.ask).toBe("a")
  h.viewer.handleInput(key("escape"))
  expect(h.ctx.state.focused).toBe("second")
  h.control.focus("ask")
  h.viewer.handleInput(textKey("b"))
  expect(h.ctx.state.inputValues.ask).toBe("ab")
  h.viewer.handleInput(key("escape"))
  expect(h.ctx.state.focused).toBe("second")
  h.control.focus("missing")
  h.render()
  expect(h.ctx.state.focused).toBe("first")
})

test("moving between inputs preserves the last navigation focus for Escape", () => {
  const h = host({
    type: "column",
    children: [
      { node: { type: "text", id: "first", lines: [] } },
      { node: { type: "text", id: "second", lines: [] } },
      { size: 1, node: input },
      { size: 1, node: { type: "input", id: "other", activate: "/" } },
    ],
  })
  for (const move of ["tab", "focus", "patch"]) {
    h.control.focus("second")
    h.viewer.handleInput(textKey("i"))
    if (move === "tab") h.viewer.handleInput(key("tab"))
    else if (move === "focus") h.control.focus("other")
    else h.control.setState({ focused: "other" })
    h.render()
    expect(h.ctx.state.focused).toBe("other")
    h.viewer.handleInput(key("escape"))
    expect(h.ctx.state.focused).toBe("second")
  }
})

test("Escape cancels an overlay, leaves a gated input, pops the page, then closes", async () => {
  const h = host()
  h.control.pushPage({})
  h.render()
  h.viewer.handleInput(textKey("i"))
  const answer = h.control.prompt("Question")
  h.viewer.handleInput(key("escape"))
  expect(await answer).toBeUndefined()
  expect(h.ctx.state.focused).toBe("ask")
  h.viewer.handleInput(key("escape"))
  h.render()
  expect(h.ctx.page?.depth).toBe(1)
  expect(h.ctx.state.focused).toBeUndefined()
  h.viewer.handleInput(key("escape"))
  h.render()
  expect(h.ctx.page).toBeUndefined()
  expect(h.closed).toBe(0)
  h.viewer.handleInput(key("escape"))
  expect(h.closed).toBe(1)
})

test("activation only targets visible inputs; other focused inputs keep their printable keys", () => {
  const h = host({
    type: "tabs",
    id: "tabs",
    tabs: [
      { key: "a", label: "A", body: { type: "input", id: "ordinary" } },
      { key: "b", label: "B", body: input },
    ],
  })
  h.viewer.handleInput(textKey("i"))
  expect(h.ctx.state.focused).toBe("tabs")
  expect(h.events.at(-1)).toEqual({ type: "key", key: "i", focused: "tabs" })
  h.control.focus("ordinary")
  h.viewer.handleInput(textKey("i"))
  expect(h.ctx.state.inputValues.ordinary).toBe("i")
  h.control.focus("tabs")
  h.viewer.handleInput(key("right"))
  h.viewer.handleInput(textKey("i")) // Newly active body, no intervening render.
  expect(h.ctx.state.focused).toBe("ask")
})

test("slash activation, reverse Tab from idle, clipped hints, and host quit keys", () => {
  const h = host({ ...input, activate: "/" })
  for (const width of [1, 2, 8, 20, 60]) {
    const lines = h.render(width)
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true)
  }
  expect(h.render().map(stripAnsi).join("\n")).toContain("/ to type")
  h.viewer.handleInput(textKey("/"))
  expect(h.ctx.state.focused).toBe("ask")
  h.viewer.handleInput(key("escape"))
  h.viewer.handleInput(key("tab", { shift: true }))
  expect(h.ctx.state.focused).toBe("ask")
  h.viewer.handleInput(key("c", { ctrl: true }))
  expect(h.closed).toBe(1)
  const idle = host()
  idle.viewer.handleInput(textKey("q"))
  expect(idle.closed).toBe(1)
})
