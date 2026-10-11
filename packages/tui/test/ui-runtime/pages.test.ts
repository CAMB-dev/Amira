import { expect, test } from "bun:test"
import type { UiContext, UiControl, UiNode, UiState, ViewDefinition, ViewRenderOptions } from "@amira/api"
import { key, monoTheme, stripAnsi, textKey } from "@amira/tui-kit"
import { ExtensionViewer } from "../../src/extension-view.ts"

const context = { theme: monoTheme, color: false, rows: 18 }
const content: UiNode = {
  type: "column",
  children: [
    {
      size: 4,
      node: {
        type: "tree",
        id: "tree",
        items: [
          { key: "a", row: [], children: [{ key: "child", row: [] }] },
          { key: "b", row: [] },
        ],
      },
    },
    {
      size: 2,
      node: {
        type: "tabs",
        id: "tabs",
        tabs: [
          { key: "first", label: "First", body: { type: "spacer" } },
          { key: "second", label: "Second", body: { type: "spacer" } },
        ],
      },
    },
    { size: 1, node: { type: "input", id: "input" } },
    {
      node: {
        type: "text",
        id: "log",
        lines: Array.from({ length: 80 }, (_, i) => ({ kind: "text", text: `Line ${i}` })),
      },
    },
  ],
}

function host(state?: Partial<UiState>, waiting: string[] = []) {
  let ctx!: UiContext
  let control!: UiControl
  let opened = 0
  let closed = 0
  let requests = 0
  const data = { label: "Root data" }
  const viewer = new ExtensionViewer(
    {
      kind: "pages",
      title: () => "Legacy title must stay hidden",
      onOpen: (_data, view) => {
        opened++
        control = view
      },
      onClose: () => closed++,
      ui(d, next) {
        expect(d).toBe(data)
        ctx = next
        return content
      },
    },
    data,
    { state, waiting: () => waiting, onClose: () => requests++ },
  )
  viewer.mount()
  const render = (rows = context.rows) => viewer.render(90, { ...context, rows }).map(stripAnsi)
  render()
  return {
    viewer,
    control,
    render,
    get ctx() {
      return ctx
    },
    get opened() {
      return opened
    },
    get closed() {
      return closed
    },
    get requests() {
      return requests
    },
  }
}

test("pages restore every widget state, input caret and independent scroll positions", () => {
  const initial: Partial<UiState> = {
    selected: { tree: "b" },
    expanded: { tree: ["a"] },
    activeTabs: { tabs: "second" },
    inputValues: { input: "draft" },
    focused: "input",
    scroll: { log: { top: 5, following: false } },
  }
  const h = host(initial)
  expect(h.ctx).not.toHaveProperty("page")
  const root = h.ctx.state
  expect(root).toMatchObject(initial)
  h.viewer.handleInput(key("left"))
  h.viewer.handleInput(key("left"))
  const pageData = { record: "detail" }
  h.control.pushPage({ data: pageData, state: { selected: { tree: "a" } } })
  h.render()
  const first = h.ctx.state
  expect(h.ctx.page).toEqual({ depth: 1, data: pageData })
  expect(first).not.toBe(root)
  expect(first.selected.tree).toBe("a")
  expect(first.inputValues.input).toBe("")
  expect(first.activeTabs.tabs).toBe("first")
  expect(first.scroll.log).toEqual({ top: 0, following: false })
  h.control.focus("log")
  h.viewer.handleInput(key("end"))
  h.render()
  const firstScroll = { ...first.scroll.log! }
  expect(firstScroll.following).toBe(true)
  h.control.pushPage({ title: "Nested", data: 42 })
  h.render()
  expect(h.ctx.page).toEqual({ depth: 2, data: 42 })
  h.control.popPage()
  h.render()
  expect(h.ctx.state).toBe(first)
  expect(h.ctx.state.scroll.log).toEqual(firstScroll)
  h.viewer.handleInput(key("escape"))
  h.render()
  expect(h.ctx).not.toHaveProperty("page")
  expect(h.ctx.state).toBe(root)
  expect(root).toMatchObject(initial)
  h.viewer.handleInput(textKey("X"))
  expect(root.inputValues.input).toBe("draXft")
  expect(initial.inputValues!.input).toBe("draft")
  h.control.popPage() // Root pop is a no-op, unlike Escape.
  expect(h.closed).toBe(0)
  h.viewer.mount()
  expect(h.opened).toBe(1)
  h.viewer.handleInput(key("escape"))
  h.viewer.dispose()
  h.control.close()
  expect(h.closed).toBe(1)
  expect(h.requests).toBe(1)
})

test("only explicit pushed titles add chrome; body height excludes title, banners and footer", () => {
  const h = host(undefined, ["Waiting for an answer"])
  expect(h.ctx.height).toBe(16)
  expect(h.render().join("\n")).not.toContain("Legacy title")
  expect(h.render().at(-1)).toContain("esc close")
  h.control.pushPage({})
  let frame = h.render()
  expect(h.ctx.height).toBe(16)
  expect(frame.at(-1)).toContain("esc back")
  expect(frame.join("\n")).not.toContain("Legacy title")
  h.control.pushPage({ title: "Record\x1b[2J details" })
  frame = h.render()
  expect(frame[0]).toBe("Record details")
  expect(frame).toHaveLength(context.rows)
  expect(h.ctx.height).toBe(15)
  expect(frame.at(-2)).toContain("Waiting for an answer")
  expect(h.render(3)).toHaveLength(3)
  expect(h.ctx.height).toBe(0)
  expect(h.render(1)).toHaveLength(1)
  expect(h.ctx.height).toBe(0)
  expect(h.render(1)[0]).toContain("esc back")
  h.control.popPage()
  h.control.popPage()
  expect(h.render().at(-1)).toContain("esc close")
})

test("a titled page offsets wheel coordinates without making its title scrollable", () => {
  let state!: UiState
  let control!: UiControl
  const viewer = new ExtensionViewer(
    {
      kind: "wheel-pages",
      title: () => "Fallback",
      onOpen: (_data, view) => {
        control = view
      },
      ui: (_data, ctx) => {
        state = ctx.state
        return {
          type: "text",
          id: "log",
          lines: Array.from({ length: 30 }, (_, i) => ({ kind: "text", text: String(i) })),
        }
      },
    },
    {},
  )
  viewer.mount()
  control.pushPage({ title: "Title" })
  viewer.render(40, context)
  const wheel = {
    type: "mouse" as const,
    action: "wheel" as const,
    button: "down" as const,
    x: 0,
    y: 0,
    ctrl: false,
    alt: false,
    shift: false,
  }
  viewer.handleInput(wheel)
  expect(state.scroll.log!.top).toBe(0)
  viewer.handleInput({ ...wheel, y: 1 })
  expect(state.scroll.log!.top).toBe(3)
})

for (const overlay of ["prompt", "confirm"] as const) {
  test(`Ctrl+C closes all pages and cancels an active ${overlay} exactly once`, async () => {
    const h = host()
    h.control.pushPage({})
    h.control.pushPage({})
    const answer = overlay === "prompt" ? h.control.prompt("Message") : h.control.confirm("Continue?")
    h.viewer.handleInput(key("c", { ctrl: true }))
    expect(await answer).toBe(overlay === "prompt" ? undefined : false)
    expect(h.closed).toBe(1)
    expect(h.requests).toBe(1)
    h.viewer.dispose()
    h.viewer.handleInput(key("c", { ctrl: true }))
    expect(h.closed).toBe(1)
  })
}

test("Escape cancels a prompt first, then pops a page, then closes the root", async () => {
  const h = host()
  h.control.pushPage({})
  const answer = h.control.prompt("Message")
  h.viewer.handleInput(key("escape"))
  expect(await answer).toBeUndefined()
  h.render()
  expect(h.ctx.page?.depth).toBe(1)
  h.viewer.handleInput(key("escape"))
  h.render()
  expect(h.ctx).not.toHaveProperty("page")
  expect(h.closed).toBe(0)
  h.viewer.handleInput(key("escape"))
  expect(h.closed).toBe(1)
})

test("lifecycle failures are isolated and hooks are not retried by frames, pages or disposal", () => {
  let control!: UiControl
  let opened = 0
  let closed = 0
  const errors: string[] = []
  const viewer = new ExtensionViewer(
    {
      kind: "lifecycle-errors",
      title: () => "Lifecycle",
      ui: () => content,
      onOpen: (_data, view) => {
        control = view
        opened++
        throw new Error("open failure")
      },
      onClose: () => {
        closed++
        throw new Error("close failure")
      },
    },
    {},
    { onError: (error) => errors.push(error) },
  )
  expect(opened).toBe(0)
  viewer.mount()
  viewer.mount()
  viewer.render(90, context)
  control.pushPage({})
  viewer.render(90, context)
  control.popPage()
  viewer.dispose()
  viewer.dispose()
  expect(opened).toBe(1)
  expect(closed).toBe(1)
  expect(errors).toEqual(["onOpen failed: open failure", "onClose failed: close failure"])
})

test("legacy pages restore the complete scroll-key map and following state", () => {
  let control!: UiControl
  let opts!: ViewRenderOptions
  const data = { id: "a" }
  const definition: ViewDefinition<typeof data> = {
    kind: "legacy-pages",
    title: () => "Legacy root",
    follow: false,
    scrollKey: (d) => d.id,
    onOpen: (_data, view) => {
      control = view
    },
    render: (_data, ctx) => {
      opts = ctx
      return Array.from({ length: 60 }, (_, i) => ({
        kind: "text",
        text: `${ctx.page?.data ?? "root"} ${i}`,
      }))
    },
  }
  const viewer = new ExtensionViewer(definition, data)
  viewer.mount()
  const render = () => viewer.render(60, context).map(stripAnsi)
  render()
  const rootA = viewer.scroll
  rootA.scrollBy(7)
  data.id = "b"
  render()
  const rootB = viewer.scroll
  rootB.scrollToEnd()
  control.pushPage({ title: "Page", data: "detail" })
  expect(render()[0]).toContain("Page")
  expect(opts.page).toEqual({ depth: 1, data: "detail" })
  expect(viewer.scroll).not.toBe(rootB)
  expect(viewer.scroll.position.top).toBe(0)
  viewer.scroll.scrollBy(4)
  control.pushPage({})
  render()
  control.popPage()
  render()
  expect(viewer.scroll.position.top).toBe(4)
  control.popPage()
  render()
  expect(opts).not.toHaveProperty("page")
  expect(viewer.scroll).toBe(rootB)
  expect(viewer.scroll.position.following).toBe(true)
  data.id = "a"
  render()
  expect(viewer.scroll).toBe(rootA)
  expect(viewer.scroll.position).toMatchObject({ top: 7, following: false })
})

test("show preserves state without an initial patch and starts a fresh root with one", () => {
  const data = { label: "New data" }
  let ctx!: UiContext
  let control!: UiControl
  let opened = 0
  let closed = 0
  const viewer = new ExtensionViewer(
    {
      kind: "show",
      title: () => "Show",
      ui: (_data, next) => {
        ctx = next
        return content
      },
      onOpen: (_data, view) => {
        opened++
        control = view
      },
      onClose: () => closed++,
    },
    {},
    { state: { inputValues: { input: "initial" }, focused: "input" } },
  )
  viewer.mount()
  viewer.render(90, context)
  const root = ctx.state
  control.pushPage({ state: { inputValues: { input: "page" }, focused: "input" } })
  viewer.render(90, context)
  const page = ctx.state
  viewer.show(data)
  viewer.render(90, context)
  expect(ctx.page?.depth).toBe(1)
  expect(ctx.state).toBe(page)
  expect(ctx.state.inputValues.input).toBe("page")
  control.popPage()
  viewer.render(90, context)
  expect(ctx.state).toBe(root)
  expect(ctx.state.inputValues.input).toBe("initial")
  control.pushPage({})
  viewer.show(data, { inputValues: { input: "replacement" } })
  viewer.render(90, context)
  expect(ctx).not.toHaveProperty("page")
  expect(ctx.state).not.toBe(root)
  expect(ctx.state.inputValues.input).toBe("replacement")
  expect(ctx.state.focused).toBe("tree")
  expect(opened).toBe(1)
  viewer.dispose()
  expect(closed).toBe(1)
})
