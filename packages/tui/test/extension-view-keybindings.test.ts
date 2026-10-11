import { expect, test } from "bun:test"
import type { ViewControl, ViewDefinition } from "@amira/api"
import { key, monoTheme, type RenderContext, stripAnsi, textKey } from "@amira/tui-kit"
import { ExtensionViewer } from "../src/extension-view.ts"
import { KeyReference } from "../src/key-reference.ts"
import { defaultKeys, parseKeybindings } from "../src/keybindings.ts"

const ctx: RenderContext = { theme: monoTheme, color: false, rows: 10 }
const defaults = defaultKeys({ vscode: false }, "linux")
const bindings = (raw: Record<string, string | string[]>) =>
  parseKeybindings(raw, "keybindings.json", defaults).keys
const view: ViewDefinition = {
  kind: "keys",
  title: () => "Keys test",
  follow: false,
  render: () => Array.from({ length: 40 }, (_, i) => ({ kind: "text", text: `row ${i}` })),
}

test("view.back uses the configured key to pop a page, then close the root", () => {
  let control!: ViewControl
  let closed = 0
  const viewer = new ExtensionViewer(
    { ...view, onOpen: (_data, host) => (control = host) },
    {},
    { keys: bindings({ "view.back": "f6" }), onClose: () => closed++ },
  )
  viewer.mount()
  control.pushPage({ title: "Child" })
  expect(viewer.render(100, ctx)[0]).toContain("Child")
  expect(viewer.handleInput(key("f6"))).toBe(true)
  expect(viewer.render(100, ctx)[0]).toContain("Keys test")
  expect(closed).toBe(0)
  expect(viewer.handleInput(key("escape"))).toBe(false)
  expect(viewer.handleInput(key("f6"))).toBe(true)
  expect(closed).toBe(1)
})

test("view.close replaces q and Ctrl+C without changing an extension's own keys", () => {
  let ran = 0
  let closed = 0
  const viewer = new ExtensionViewer(
    { ...view, keys: [{ key: "x", label: "run", run: () => ran++ }] },
    {},
    { keys: bindings({ "view.close": "f7" }), onClose: () => closed++ },
  )
  expect(viewer.handleInput(textKey("q"))).toBe(false)
  expect(viewer.handleInput(key("c", { ctrl: true }))).toBe(false)
  expect(viewer.handleInput(textKey("x"))).toBe(true)
  expect(ran).toBe(1)
  expect(viewer.handleInput(key("f7"))).toBe(true)
  expect(closed).toBe(1)
})

test("shared scroll bindings replace the hardcoded page keys in legacy views", () => {
  const viewer = new ExtensionViewer(
    view,
    {},
    {
      keys: bindings({ "scroll.page-down": "f8", "scroll.top": "f9", "scroll.bottom": [] }),
    },
  )
  viewer.render(100, ctx)
  expect(viewer.handleInput(key("f8"))).toBe(true)
  expect(viewer.scroll.position.top).toBe(6)
  expect(viewer.handleInput(key("pagedown"))).toBe(false)
  expect(viewer.handleInput(key("end"))).toBe(false)
  expect(viewer.scroll.position.top).toBe(6)
  expect(viewer.handleInput(key("f9"))).toBe(true)
  expect(viewer.scroll.position.top).toBe(0)
})

test("declarative scroll regions use the same configured page keys", () => {
  const viewer = new ExtensionViewer(
    {
      ...view,
      ui: () => ({
        type: "text",
        id: "output",
        lines: Array.from({ length: 40 }, (_, i) => ({ kind: "text", text: `row ${i}` })),
      }),
    },
    {},
    { keys: bindings({ "scroll.page-down": "f8" }) },
  )
  expect(viewer.render(100, ctx)[0]).toContain("row 0")
  expect(viewer.handleInput(key("f8"))).toBe(true)
  expect(viewer.render(100, ctx)[0]).toContain("row 9")
  expect(viewer.handleInput(key("pagedown"))).toBe(false)
  expect(viewer.render(100, ctx)[0]).toContain("row 9")
})

test("unbound host actions have no hardcoded fallback", () => {
  let closed = 0
  const viewer = new ExtensionViewer(
    view,
    {},
    {
      keys: bindings({
        "view.back": [],
        "view.close": [],
        "view.scroll-up": [],
        "view.scroll-down": [],
        "scroll.up": [],
        "scroll.down": [],
        "scroll.page-up": [],
        "scroll.page-down": [],
        "scroll.top": [],
        "scroll.bottom": [],
      }),
      onClose: () => closed++,
    },
  )
  viewer.render(100, ctx)
  for (const event of [
    key("escape"),
    textKey("q"),
    key("c", { ctrl: true }),
    key("up"),
    key("down"),
    key("up", { shift: true }),
    key("down", { shift: true }),
    key("pageup"),
    key("pagedown"),
    key("home"),
    key("end"),
  ])
    expect(viewer.handleInput(event)).toBe(false)
  expect(closed).toBe(0)
  expect(viewer.scroll.position.top).toBe(0)
  expect(stripAnsi(viewer.render(100, ctx).at(-1)!)).toBe("1–7 of 40")
})

test("declarative inputs keep q and printable back bindings; a remapped back releases input", () => {
  let closed = 0
  const submitted: string[] = []
  const viewer = new ExtensionViewer(
    {
      ...view,
      ui: () => ({
        type: "column",
        children: [
          { node: { type: "input", id: "input", activate: "/" } },
          { node: { type: "text", id: "output", lines: [{ kind: "text", text: "Output" }] } },
        ],
      }),
      onEvent: (event) => {
        if (event.type === "submit") submitted.push(event.value)
      },
    },
    {},
    {
      state: { focused: "input" },
      keys: bindings({ "view.back": ["f6", "x"] }),
      onClose: () => closed++,
    },
  )
  viewer.render(100, ctx)
  expect(viewer.handleInput(textKey("q"))).toBe(true)
  expect(viewer.handleInput(textKey("x"))).toBe(true)
  expect(viewer.handleInput(key("escape"))).toBe(false)
  expect(viewer.handleInput(key("enter"))).toBe(true)
  expect(submitted).toEqual(["qx"])
  expect(closed).toBe(0)
  expect(viewer.handleInput(key("f6"))).toBe(true)
  expect(closed).toBe(0)
  expect(viewer.handleInput(textKey("q"))).toBe(true)
  expect(closed).toBe(1)
})

test("extension-defined shortcuts take precedence over shared scroll keys", () => {
  for (const declarative of [false, true]) {
    let ran = 0
    const viewer = new ExtensionViewer(
      {
        ...view,
        keys: [{ key: "x", label: "run", run: () => ran++ }],
        ...(declarative
          ? {
              ui: () => ({
                type: "text" as const,
                id: "output",
                lines: view.render!({}, { width: 100, now: 0 }),
              }),
              onEvent: () => ran++,
            }
          : {}),
      },
      {},
      { keys: bindings({ "scroll.page-down": "x" }) },
    )
    viewer.render(100, ctx)
    expect(viewer.handleInput(textKey("x"))).toBe(true)
    expect(ran).toBe(1)
    expect(viewer.render(100, ctx).join("\n")).toContain("row 0")
  }
})

test("binding a shared scroll key to view.back warns about the view-scope conflict", () => {
  const { warnings } = parseKeybindings({ "view.back": "pageup" }, "keybindings.json", defaults)
  expect(warnings).toEqual(['keybindings.json: pgup is bound to both "view.back" and "scroll.page-up"'])
})

test("view hints and the key reference show the current host bindings", () => {
  const { keys, warnings } = parseKeybindings(
    {
      "view.back": "f6",
      "view.close": "f7",
      "view.scroll-up": "k",
      "view.scroll-down": "j",
      "scroll.page-up": "f8",
      "scroll.page-down": [],
      "scroll.top": [],
      "scroll.bottom": [],
    },
    "keybindings.json",
    defaults,
  )
  expect(warnings).toEqual([])
  const viewer = new ExtensionViewer(view, {}, { keys })
  expect(stripAnsi(viewer.render(120, ctx).at(-1)!)).toBe("1–7 of 40 · kj f8 scroll · f6 close")
  const minimal = new ExtensionViewer({ ...view, hostKeys: "minimal" }, {}, { keys })
  expect(stripAnsi(minimal.render(120, ctx).at(-1)!)).toBe("f6 close")
  const reference = new KeyReference(keys, { fullscreen: false, onClose: () => {} })
  const text = reference
    .render(180, { ...ctx, rows: 300 })
    .map(stripAnsi)
    .join("\n")
  expect(text).toContain("Extension views")
  expect(text).toMatch(/f6 +.*view\.back/)
  expect(text).toMatch(/f7 +.*view\.close/)
  expect(text).toMatch(/f8 +.*scroll\.page-up/)
})
