import { expect, test } from "bun:test"
import type { UiContext, UiControl, ViewDefinition } from "@amira/api"
import { CURSOR_MARKER, key, monoTheme, stripAnsi, textKey, visibleWidth } from "@amira/tui-kit"
import { ExtensionViewer } from "../../src/extension-view.ts"

const context = { theme: monoTheme, color: false, rows: 8 }

function host(hostKeys?: ViewDefinition["hostKeys"], legacy = false, waiting: string[] = []) {
  let ctx!: UiContext
  let control!: UiControl
  let closed = 0
  let actions = 0
  const lines = Array.from({ length: 30 }, (_, i) => ({ kind: "text" as const, text: `Body ${i}` }))
  const viewer = new ExtensionViewer(
    {
      kind: "host-keys",
      title: () => "Title",
      hostKeys,
      follow: false,
      keys: [{ key: "x", label: "act", run: () => actions++ }],
      onOpen: (_data, view) => {
        control = view
      },
      onEvent: () => actions++,
      ...(legacy
        ? { render: () => lines }
        : {
            ui: (_data: unknown, next: UiContext) => {
              ctx = next
              return { type: "text" as const, lines }
            },
          }),
    },
    {},
    { waiting: () => waiting, onClose: () => closed++ },
  )
  viewer.mount()
  const render = (rows = context.rows, width = 100) => viewer.render(width, { ...context, rows })
  render()
  return {
    viewer,
    control,
    render,
    get ctx() {
      return ctx
    },
    get closed() {
      return closed
    },
    get actions() {
      return actions
    },
  }
}

for (const legacy of [false, true]) {
  test(`host key modes preserve shortcuts and page escape behavior (${legacy ? "legacy" : "ui"})`, () => {
    const full = host(undefined, legacy)
    const explicit = host("full", legacy)
    expect(explicit.render()).toEqual(full.render())
    expect(stripAnsi(full.render().at(-1)!)).toContain("x act")
    for (const mode of ["minimal", "none"] as const) {
      const h = host(mode, legacy)
      const frame = h.render().map(stripAnsi)
      expect(frame).toHaveLength(context.rows)
      expect(frame.join("\n")).not.toContain("x act")
      if (mode === "minimal") expect(frame.at(-1)).toBe("Esc close")
      else expect(frame.at(-1)).toBe(legacy ? "Body 5" : "Body 7".padEnd(100))
      if (!legacy) expect(h.ctx.height).toBe(mode === "none" ? 8 : 7)
      else expect(h.viewer.scroll.height).toBe(mode === "none" ? 6 : 5)
      h.viewer.handleInput(textKey("x"))
      expect(h.actions).toBe(1)
      h.control.pushPage({ title: "Details" })
      const page = h.render().map(stripAnsi)
      expect(page[0]).toContain("Details")
      if (mode === "minimal") expect(page.at(-1)).toBe("Esc back")
      else expect(page.join("\n")).not.toContain("Esc")
      h.viewer.handleInput(key("escape"))
      expect(h.closed).toBe(0)
      h.render()
      h.viewer.handleInput(key("escape"))
      expect(h.closed).toBe(1)
    }
  })
}

for (const mode of ["minimal", "none"] as const) {
  test(`${mode} keeps prompts and confirmations visible with their own footer row`, async () => {
    const h = host(mode)
    const answer = h.control.prompt("Message")
    let frame = h.render()
    expect(frame).toHaveLength(context.rows)
    expect(stripAnsi(frame.at(-1)!)).toContain("Message")
    expect(frame.join("\n")).toContain(CURSOR_MARKER)
    expect(h.ctx.height).toBe(7)
    h.viewer.handleInput(textKey("hello"))
    h.viewer.handleInput(key("enter"))
    expect(await answer).toBe("hello")
    const confirmed = h.control.confirm("Continue?")
    frame = h.render()
    expect(stripAnsi(frame.at(-1)!)).toContain("Continue? y yes")
    expect(h.ctx.height).toBe(7)
    h.viewer.handleInput(key("escape"))
    expect(await confirmed).toBe(false)
    expect(h.closed).toBe(0)
    h.render()
    expect(h.ctx.height).toBe(mode === "none" ? 8 : 7)
  })
}

test("hidden footer releases its cell even with a page title and waiting banners", () => {
  const h = host("none", false, ["Waiting"])
  expect(h.ctx.height).toBe(7)
  expect(h.render().map(stripAnsi).at(-1)).toContain("Waiting")
  h.control.pushPage({ title: "Page" })
  const frame = h.render().map(stripAnsi)
  expect(frame[0]).toBe("Page")
  expect(frame.at(-1)).toContain("Waiting")
  expect(h.ctx.height).toBe(6)
  expect(h.render(1)).toHaveLength(1)
  expect(h.ctx.height).toBe(0)
  expect(h.render(0)).toEqual([])
  for (const mode of ["full", "minimal", "none"] as const) {
    const narrow = host(mode)
    expect(narrow.render(1, 4).every((line) => visibleWidth(line) <= 4)).toBe(true)
  }
})
