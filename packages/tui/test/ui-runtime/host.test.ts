import { expect, test } from "bun:test"
import type { UiControl, UiEvent, UiNode, UiState, ViewDefinition } from "@amira/api"
import { CURSOR_MARKER, key, monoTheme, stripAnsi, textKey, visibleWidth } from "@amira/tui-kit"
import { ExtensionViewer } from "../../src/extension-view.ts"
import { dashboard, dashboardData } from "./dashboard-fixture.ts"

const context = { theme: monoTheme, color: false, rows: 12 }
const node: UiNode = {
  type: "column",
  children: [
    {
      node: {
        type: "tree",
        id: "t",
        items: [
          { key: "a", row: [{ kind: "text", text: "A" }] },
          { key: "b", row: [{ kind: "text", text: "B" }] },
        ],
      },
    },
    { size: 1, node: { type: "input", id: "i", placeholder: "Type a message" } },
  ],
}

function host() {
  let state!: UiState
  let control!: UiControl
  let closed = 0
  let renders = 0
  let prompt: Promise<string | undefined> | undefined
  let confirm: Promise<boolean> | undefined
  const events: UiEvent[] = []
  const errors: string[] = []
  const definition: ViewDefinition<{ label: string }> = {
    kind: "host-proof",
    keys: [
      { key: "p", label: "prompt" },
      { key: "c", label: "confirm" },
    ],
    title: () => {
      throw new Error("UI must not evaluate legacy title")
    },
    header: () => {
      throw new Error("UI must not evaluate legacy header")
    },
    render: () => {
      throw new Error("UI must not evaluate legacy render")
    },
    ui(data, ctx) {
      state = ctx.state
      return {
        type: "column",
        children: [{ size: 1, node: { type: "bar", left: [{ kind: "text", text: data.label }] } }, { node }],
      }
    },
    onEvent(event, _data, view) {
      control = view
      events.push(event)
      if (event.type === "key" && event.key === "p") prompt = view.prompt("Question", { initial: "answer" })
      if (event.type === "key" && event.key === "c") confirm = view.confirm("Continue?")
      if (event.type === "select") view.setState({ selected: { t: "a" } })
    },
  }
  const viewer = new ExtensionViewer(
    definition,
    { label: "First" },
    { requestRender: () => renders++, onClose: () => closed++, onError: (s) => errors.push(s) },
  )
  const render = () => viewer.render(60, context)
  render()
  return {
    viewer,
    definition,
    render,
    events,
    errors,
    get state() {
      return state
    },
    get control() {
      return control
    },
    get closed() {
      return closed
    },
    get renders() {
      return renders
    },
    get prompt() {
      return prompt
    },
    get confirm() {
      return confirm
    },
  }
}

test("ui replaces legacy screen content and data replacement preserves overridden state", () => {
  const h = host()
  h.viewer.handleInput(key("down"))
  expect(h.state.selected.t).toBe("a")
  expect(h.events[0]).toEqual({ type: "select", id: "t", key: "b" })
  h.control.focus("i")
  h.viewer.handleInput({ type: "paste", text: "draft" })
  h.viewer.show({ label: "Second" })
  expect(h.render().map(stripAnsi).join("\n")).toContain("Second")
  expect(h.state.focused).toBe("i")
  expect(h.state.inputValues.i).toBe("draft")
  expect(h.errors).toEqual([])
  expect(h.renders).toBeGreaterThan(0)
})

test("prompt and confirm overlays own input and the only cursor; show/dispose cancel pending answers", async () => {
  const h = host()
  h.viewer.handleInput(textKey("p"))
  h.control.focus("i")
  const promptFrame = h.render().join("\n")
  expect(promptFrame.split(CURSOR_MARKER)).toHaveLength(2)
  expect(promptFrame.indexOf(CURSOR_MARKER)).toBeGreaterThan(promptFrame.indexOf("Question"))
  h.viewer.handleInput(textKey("q")) // Prompt accepts q; it does not close the host.
  h.viewer.handleInput(key("enter"))
  expect(await h.prompt).toBe("answerq")
  expect(h.closed).toBe(0)
  h.control.focus("t")
  h.viewer.handleInput(textKey("c"))
  h.control.focus("i")
  expect(h.render().join("\n")).not.toContain(CURSOR_MARKER)
  h.viewer.handleInput(textKey("y"))
  expect(await h.confirm).toBe(true)
  h.control.focus("t")
  h.viewer.handleInput(textKey("p"))
  h.viewer.show({ label: "New object" })
  expect(await h.prompt).toBeUndefined()
  h.viewer.handleInput(textKey("c"))
  h.viewer.dispose()
  expect(await h.confirm).toBe(false)
})

test("host reserves q outside inputs, and Escape and Ctrl+C everywhere; a focused input types q", () => {
  const h = host()
  h.viewer.handleInput(textKey("q"))
  expect(h.closed).toBe(1)
  for (const e of [key("escape"), key("c", { ctrl: true })]) {
    const g = host()
    g.viewer.handleInput(key("tab"))
    g.viewer.handleInput(e)
    expect(g.closed).toBe(1)
  }
  const g = host()
  g.viewer.handleInput(key("tab"))
  g.viewer.handleInput(textKey("q"))
  expect(g.closed).toBe(0)
  expect(g.state.inputValues.i).toBe("q")
})

test("data mutations and focus patches are reflected before the next input in a burst", () => {
  const data = { alternate: false }
  const submitted: string[] = []
  const view: ViewDefinition<typeof data> = {
    kind: "burst",
    title: () => "Burst",
    ui: (d) =>
      d.alternate
        ? { type: "input", id: "new" }
        : { type: "tree", id: "old", items: [{ key: "go", row: [] }] },
    onEvent(event, d, control) {
      if (event.type === "activate") {
        d.alternate = true
        control.focus("new")
      }
      if (event.type === "submit") submitted.push(event.value)
    },
  }
  const viewer = new ExtensionViewer(view, data)
  viewer.render(30, context)
  viewer.handleInput(key("enter"))
  viewer.handleInput(textKey("x"))
  viewer.handleInput(key("enter"))
  expect(submitted).toEqual(["x"])
})

test("runtime failures are isolated, deduplicated and sanitized; only declared keys emit events", () => {
  const errors: string[] = []
  const events: UiEvent[] = []
  let calls = 0
  const view: ViewDefinition = {
    kind: "failure",
    title: () => "Fallback",
    ui: () => {
      throw new Error("bad\x1b[2Joutput")
    },
    onEvent: (e) => events.push(e),
    keys: [{ key: "x", label: "act", run: () => calls++ }],
  }
  const viewer = new ExtensionViewer(view, {}, { onError: (e) => errors.push(e) })
  const frame = viewer.render(60, context)
  viewer.render(60, context)
  expect(errors).toHaveLength(1)
  expect(frame.map(stripAnsi).join("\n")).toContain("badoutput")
  expect(frame.join("\n")).not.toContain("\x1b[2J")
  viewer.handleInput(textKey("x"))
  viewer.handleInput(key("z", { ctrl: true }))
  expect(calls).toBe(0) // UI keys use onEvent, not the legacy handler.
  expect(events).toEqual([{ type: "key", key: "x", focused: undefined }])
})

for (const [width, height] of [
  [180, 52],
  [80, 24],
]) {
  test(`semantic dashboard snapshot ${width}x${height}`, () => {
    const viewer = new ExtensionViewer(dashboard, dashboardData(), { now: () => 42_000 })
    const ctx = { ...context, rows: height! }
    viewer.render(width!, ctx)
    viewer.handleInput(textKey("i"))
    const lines = viewer.render(width!, ctx)
    expect(lines).toHaveLength(height!)
    expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true)
    expect(
      lines.map((line) => stripAnsi(line).replaceAll(CURSOR_MARKER, "").trimEnd()).join("\n"),
    ).toMatchSnapshot()
  })
}

test("proof fixture imports only the public API and no prototype/runtime modules", async () => {
  const source = await Bun.file(new URL("./dashboard-fixture.ts", import.meta.url)).text()
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])
  expect(imports).toEqual(["@amira/api"])
})

test("declarative prompt/confirm strings and fallback titles cannot inject terminal escapes", async () => {
  let control!: UiControl
  let fail = false
  const dirty = "old\r\x1b[2Jsafe\x1b]0;injected\x07"
  const definition: ViewDefinition = {
    kind: "safe-overlays",
    keys: [{ key: "x", label: "" }],
    title: () => dirty,
    ui: () => {
      if (fail) throw new Error(dirty)
      return node
    },
    onEvent: (_event, _data, view) => {
      control = view
    },
  }
  const viewer = new ExtensionViewer(definition, {})
  const render = () => viewer.render(100, context)
  render()
  viewer.handleInput(textKey("x"))
  const prompt = control.prompt(dirty, { initial: dirty })
  let output = render().map(stripAnsi).join("\n")
  expect(output).not.toContain("injected")
  expect(output).not.toContain("old")
  viewer.handleInput(key("enter"))
  expect(await prompt).toBe("safe")
  const confirm = control.confirm(dirty, { yes: dirty, no: dirty })
  output = render().map(stripAnsi).join("\n")
  expect(output).not.toContain("injected")
  expect(output).not.toContain("old")
  viewer.handleInput(textKey("y"))
  expect(await confirm).toBe(true)
  fail = true
  output = render().map(stripAnsi).join("\n")
  expect(output).toStartWith("safe")
  expect(output).not.toContain("injected")
})

test("waiting banners are sanitized and cannot displace the host footer", () => {
  const viewer = new ExtensionViewer(
    { kind: "waiting", title: () => "Waiting", ui: () => node },
    {},
    {
      waiting: () => Array<string>(40).fill("\x1b[2JQuestion\nnext line"),
    },
  )
  const lines = viewer.render(80, context)
  expect(lines).toHaveLength(context.rows)
  expect(stripAnsi(lines.at(-1)!)).toContain("Esc close")
  expect(lines.join("\n")).not.toContain("\x1b[2J")
  expect(stripAnsi(lines[0]!)).toContain("Question next line")
})
