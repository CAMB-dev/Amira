import { expect, test } from "bun:test"
import { stripAnsi } from "../src/ansi.ts"
import { CURSOR_MARKER } from "../src/component.ts"
import { Form, type FormOptions } from "../src/components/form.ts"
import { key, type MouseInput } from "../src/keys.ts"
import { plain } from "./context.ts"

function make(over: Partial<FormOptions> = {}) {
  const events: string[] = []
  const form = new Form({
    title: "Provider",
    layout: "card",
    fields: [
      { id: "name", type: "text", label: "Name" },
      {
        id: "models",
        type: "multiselect",
        label: "Models",
        options: [{ value: "alpha" }, { value: "beta" }, { value: "gamma" }],
      },
      { id: "test", type: "action", label: "Test", placement: "footer" },
    ],
    preview: () => ["settings.json", "masked key"],
    onSubmit: () => events.push("save"),
    onCancel: () => events.push("cancel"),
    onAction: (id) => events.push(id),
    ...over,
  })
  const view = () =>
    form.render(120, { ...plain, rows: 36 }).map((line) => stripAnsi(line).replaceAll(CURSOR_MARKER, ""))
  return { form, events, view }
}

function focus(form: Form, id: string) {
  for (let i = 0; i < 100 && form.focused !== id; i++) form.handleInput(key("tab", { shift: true }))
  expect(form.focused).toBe(id)
}

function click(form: Form, lines: string[], text: string) {
  const y = lines.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = lines[y]!.indexOf(text) + 1
  for (const action of ["press", "release"] as const) {
    const event: MouseInput = {
      type: "mouse",
      action,
      button: "left",
      x,
      y,
      shift: false,
      ctrl: false,
      alt: false,
    }
    form.handleInput(event)
  }
}

test("card preview starts folded, never joins traversal, and expands by click or keyboard", () => {
  const { form, view } = make()
  expect(view().join("\n")).toContain("Preview settings.json (2 lines)")
  expect(view().join("\n")).not.toContain("masked key")
  const order: string[] = []
  for (let i = 0; i < 12; i++) {
    order.push(form.focused)
    form.handleInput(key("tab"))
  }
  expect(order).not.toContain("preview")
  click(form, view(), "Preview settings.json")
  expect(view().join("\n")).toContain("masked key")
  expect(form.focused).not.toBe("preview")
  form.handleInput(key("enter"))
  expect(view().join("\n")).not.toContain("masked key")
  form.handleInput(key("p", { ctrl: true }))
  expect(view().join("\n")).toContain("masked key")
  form.handleInput(key("up"))
  expect(form.focused).not.toBe("preview")
})

test("card footer supports bounded horizontal movement and backwards entry from the first field", () => {
  const { form, events } = make()
  form.handleInput(key("tab", { shift: true }))
  expect(form.focused).toBe("cancel")
  form.handleInput(key("right"))
  expect(form.focused).toBe("cancel")
  form.handleInput(key("left"))
  expect(form.focused).toBe("submit")
  form.handleInput(key("left"))
  expect(form.focused).toBe("test")
  form.handleInput(key("left"))
  expect(form.focused).toBe("test")
  form.handleInput(key("enter"))
  expect(events).toEqual(["test"])
})

test("card multiselect has clickable All/None and preserves the filtered scope", () => {
  const { form, view } = make()
  focus(form, "models")
  form.handleInput({ type: "paste", text: "a" })
  click(form, view(), "[ All ]")
  expect(form.values.models).toEqual(["alpha", "beta", "gamma"])
  form.handleInput(key("right"))
  form.handleInput(key("enter"))
  expect(form.values.models).toEqual([])
  form.handleInput(key("left"))
  form.handleInput(key("left"))
  form.handleInput(key("enter"))
  expect(form.values.models).toEqual(["alpha", "beta", "gamma"])
  focus(form, "models")
  form.handleInput(key("escape"))
  form.handleInput({ type: "paste", text: "beta" })
  click(form, view(), "[ None ]")
  expect(form.values.models).toEqual(["alpha", "gamma"])
  form.handleInput(key("a", { ctrl: true }))
  expect(form.values.models).toEqual(["alpha", "gamma", "beta"])
  form.handleInput(key("a", { ctrl: true }))
  expect(form.values.models).toEqual(["alpha", "gamma"])
})

test("card open dropdown uses horizontal choices and Esc closes before the form", () => {
  const { form, events } = make({
    fields: [
      { id: "vendor", type: "select", label: "Vendor", options: [{ value: "one" }, { value: "two" }] },
    ],
  })
  form.handleInput(key("right"))
  expect(form.values.vendor).toBe("one")
  form.handleInput(key("enter"))
  form.handleInput(key("right"))
  form.handleInput(key("enter"))
  expect(form.values.vendor).toBe("two")
  form.handleInput(key("enter"))
  form.handleInput(key("escape"))
  expect(form.confirmingCancel).toBe(false)
  expect(events).toEqual([])
  form.handleInput(key("escape"))
  expect(form.confirmingCancel).toBe(true)
})

test("card summary hides grouped fields until Enter or click and validation expands them", () => {
  const summary = {
    id: "endpoint",
    fields: ["id", "protocol", "url"],
    label: "Endpoint",
    text: "openai-chat · https://example.test",
  }
  const { form, view } = make({
    fields: [
      { id: "vendor", type: "select", label: "Vendor", options: [{ value: "catalog" }] },
      { id: "id", type: "text", label: "Id" },
      { id: "protocol", type: "text", label: "Protocol" },
      { id: "url", type: "text", label: "Base URL" },
    ],
    summaries: [summary],
    validate: (values): Record<string, string> => (values.url ? {} : { url: "A URL is required" }),
  })
  expect(view().join("\n")).toContain("openai-chat · https://example.test [ Edit ]")
  expect(view().join("\n")).not.toContain("Base URL")
  form.handleInput(key("down"))
  expect(form.focused).toBe("\0summary:endpoint")
  form.handleInput(key("left"))
  form.handleInput(key("right"))
  expect(form.focused).toBe("\0summary:endpoint")
  form.handleInput(key("enter"))
  expect(view().join("\n")).toContain("Base URL")
  click(form, view(), "[ Edit ]")
  expect(view().join("\n")).not.toContain("Base URL")
  form.handleInput(key("s", { ctrl: true }))
  expect(form.focused).toBe("url")
  expect(view().join("\n")).toContain("A URL is required")
  form.setSummaries([{ ...summary, text: "openai-chat · https://other.test" }])
  expect(view().join("\n")).toContain("Base URL") // Updating summary text must not hide an active edit.
  form.setSummaries([{ ...summary, id: "other-vendor" }])
  expect(view().join("\n")).not.toContain("Base URL")
  form.setSummaries([])
  expect(view().join("\n")).toContain("Base URL")
})

test("card Ctrl+T only activates the explicit test action and Ctrl+S directly saves", () => {
  const { form, events } = make({
    fields: [
      { id: "key", type: "secret", label: "Key" },
      { id: "probe", type: "action", label: "Test", placement: "footer", shortcut: "ctrl+t" },
    ],
  })
  form.handleInput(key("t", { ctrl: true }))
  expect(events).toEqual(["probe"])
  form.setActionState("probe", { running: true })
  form.handleInput(key("t", { ctrl: true }))
  expect(events).toEqual(["probe"])
  form.handleInput(key("s", { ctrl: true }))
  expect(events).toEqual(["probe", "save"])
})

test("card vertical keys traverse fields while text arrows move the caret", () => {
  const { form } = make()
  form.handleInput({ type: "paste", text: "abcd" })
  form.handleInput(key("left"))
  form.handleInput({ type: "paste", text: "!" })
  expect(form.values.name).toBe("abc!d")
  form.handleInput(key("enter"))
  expect(form.focused).toBe("name")
  form.handleInput(key("down"))
  expect(form.focused).toBe("models")
  form.handleInput(key("down"))
  expect(form.focused).toBe("\0bulk:all:models")
  form.handleInput(key("up"))
  expect(form.focused).toBe("models")
  form.handleInput(key("up"))
  expect(form.focused).toBe("name")
})

test("card All/None and Ctrl+A work without a filter and keep outside clicks inert", () => {
  const { form, view } = make()
  focus(form, "models")
  form.handleInput(key("a", { ctrl: true }))
  expect(form.values.models).toEqual(["alpha", "beta", "gamma"])
  form.handleInput(key("a", { ctrl: true }))
  expect(form.values.models).toEqual([])
  click(form, view(), "[ All ]")
  expect(form.values.models).toEqual(["alpha", "beta", "gamma"])
  click(form, view(), "[ None ]")
  expect(form.values.models).toEqual([])
  for (const action of ["press", "release"] as const)
    form.handleInput({
      type: "mouse",
      action,
      button: "left",
      x: 0,
      y: 0,
      shift: false,
      ctrl: false,
      alt: false,
    })
  expect(form.values.models).toEqual([])
})

test("expanded card preview scrolls with the body while the footer stays fixed", () => {
  const { form, view } = make({ preview: () => Array.from({ length: 60 }, (_, i) => `preview line ${i}`) })
  const before = view()
  click(form, before, "Preview settings.json")
  let lines = view()
  const footer = lines.findIndex((line) => line.includes("[ Save ]"))
  const y = lines.findIndex((line) => line.includes("Preview settings.json"))
  const x = lines[y]!.indexOf("Preview settings.json")
  form.handleInput({
    type: "mouse",
    action: "wheel",
    button: "down",
    x,
    y,
    shift: false,
    ctrl: false,
    alt: false,
  })
  lines = view()
  expect(lines.findIndex((line) => line.includes("[ Save ]"))).toBe(footer)
  expect(form.focused).toBe("name")
  form.handleInput(key("down"))
  expect(form.focused).toBe("models")
})

test("inline Fetch shares the Models row, status, mouse targets and bounded button navigation", () => {
  const { form, events, view } = make({
    fields: [
      { id: "fetch", type: "action", label: "Fetch models", buttonLabel: "Fetch", inline: "models" },
      { id: "models", type: "multiselect", label: "Models", options: [{ value: "demo" }] },
    ],
  })
  let lines = view()
  const row = lines.find((line) => line.includes("selected 0/1"))!
  expect(row).toContain("[ All ] [ None ] [ Fetch ]")
  expect(lines.join("\n")).not.toContain("Fetch models")
  click(form, lines, "[ Fetch ]")
  expect(events).toEqual(["fetch"])
  expect(form.focused).toBe("fetch")
  form.handleInput(key("right"))
  expect(form.focused).toBe("fetch")
  form.handleInput(key("left"))
  expect(form.focused).toBe("\0bulk:none:models")
  form.handleInput(key("right"))
  expect(form.focused).toBe("fetch")
  form.setActionState("fetch", { running: true, text: "asking the provider…" })
  lines = view()
  const models = lines.findIndex((line) => line.includes("selected 0/1"))
  expect(lines[models + 1]).toContain("asking the provider")
  expect(lines.join("\n")).toContain("Esc stops it")
  form.handleInput(key("left"))
  expect(view().join("\n")).toContain("Focus Fetch, then Esc to stop")
  form.handleInput(key("right"))
  form.setActionState("fetch", { running: false, text: "1 model listed", tone: "success" })
  expect(view()[models + 1]).toContain("1 model listed")
  form.handleInput(key("enter"))
  expect(events).toEqual(["fetch", "fetch"])
})

test("card counts multiline preview text and Page keys scroll the body without a preview focus stop", () => {
  const { form } = make({
    preview: () => [
      "settings.json",
      Array.from({ length: 60 }, (_, i) => `preview line ${i}`).join("\n"),
      "masked key",
    ],
  })
  const view = () =>
    form
      .render(120, { ...plain, rows: 24 })
      .map(stripAnsi)
      .join("\n")
  expect(view()).toContain("Preview settings.json (62 lines)")
  form.handleInput(key("p", { ctrl: true }))
  view()
  form.handleInput(key("tab", { shift: true }))
  expect(form.focused).toBe("cancel")
  for (let i = 0; i < 8; i++) {
    form.handleInput(key("pagedown"))
    view()
  }
  expect(view()).toContain("preview line 59")
  expect(view()).toContain("masked key")
  expect(view()).toContain("[ Save ]")
  expect(form.focused).toBe("cancel")
  form.handleInput(key("pageup"))
  expect(view()).not.toContain("preview line 59")
  expect(form.focused).toBe("cancel")
  form.handleInput(key("up"))
  expect(form.focused).toBe("submit")
})

test("running Test guidance follows action focus and Escape still closes a dropdown first", () => {
  const stopped: string[] = []
  const { form, events, view } = make({
    fields: [
      { id: "vendor", type: "select", label: "Vendor", options: [{ value: "one" }, { value: "two" }] },
      {
        id: "probe",
        type: "action",
        label: "Test connection",
        buttonLabel: "Test",
        placement: "footer",
        shortcut: "ctrl+t",
      },
    ],
    onActionCancel: (id) => stopped.push(id),
  })
  form.handleInput(key("enter"))
  form.handleInput(key("right"))
  form.handleInput(key("enter"))
  form.handleInput(key("enter"))
  form.handleInput(key("t", { ctrl: true }))
  form.setActionState("probe", { running: true, text: "checking the connection" })
  expect(events).toEqual(["probe"])
  expect(form.focused).toBe("vendor")
  expect(view().join("\n")).not.toContain("Esc stops it")
  expect(view().join("\n")).toContain("Focus Test, then Esc to stop")
  form.setActionState("probe", { running: true, text: "checking the connection ".repeat(8) })
  expect(
    form
      .render(80, { ...plain, rows: 24 })
      .map(stripAnsi)
      .join("\n"),
  ).toContain("Focus Test, then Esc to stop")
  form.handleInput(key("escape"))
  expect(form.confirmingCancel).toBe(false)
  expect(stopped).toEqual([])
  form.handleInput(key("escape"))
  expect(form.confirmingCancel).toBe(true)
  expect(stopped).toEqual([])
  form.handleInput(key("n"))
  form.handleInput(key("tab"))
  expect(form.focused).toBe("probe")
  expect(view().join("\n")).toContain("Esc stops it")
  form.handleInput(key("escape"))
  expect(stopped).toEqual(["probe"])
  expect(form.confirmingCancel).toBe(false)
})

test.each(["All", "None"])("Escape on filtered %s clears the model filter before discard", (button) => {
  for (const method of ["mouse", "keyboard"]) {
    const { form, view } = make()
    form.setValues({ name: "changed", models: ["beta"] })
    focus(form, "models")
    form.handleInput({ type: "paste", text: "beta" })
    if (method === "mouse") click(form, view(), `[ ${button} ]`)
    else {
      form.handleInput(key("tab"))
      if (button === "None") form.handleInput(key("right"))
      form.handleInput(key("enter"))
    }
    expect(form.focused).toBe(`\0bulk:${button.toLowerCase()}:models`)
    expect(view().join("\n")).toContain("filter: beta")
    const selected = form.values.models
    form.handleInput(key("escape"))
    expect(form.confirmingCancel).toBe(false)
    expect(view().join("\n")).not.toContain("filter: beta")
    expect(form.values.models).toEqual(selected)
    form.handleInput(key("escape"))
    expect(form.confirmingCancel).toBe(true)
  }
})

test("80x24 card hints keep save, test, preview and Escape guidance on one complete line", () => {
  const { form } = make({
    fields: [
      { id: "name", type: "text", label: "Name" },
      { id: "probe", type: "action", label: "Test", placement: "footer", shortcut: "ctrl+t" },
    ],
  })
  for (const width of [80, 61]) {
    const hints = new Set<string>()
    for (let i = 0; i < 4; i++) {
      const lines = form.render(width, { ...plain, rows: 24 }).map(stripAnsi)
      const hint = lines.find((line) => line.includes("^S save"))!
      expect(hint).toBeDefined()
      expect(hint).toContain("^T test")
      expect(hint).toContain("^P preview")
      expect(hint).toContain("Esc back")
      expect(hint).not.toContain("…")
      hints.add(hint)
      form.handleInput(key("tab"))
    }
    expect(hints.size).toBe(1)
  }
})

test.each(["card", undefined] as const)(
  "body action stop guidance follows its focus (layout: %s)",
  (layout) => {
    const { form, view } = make({
      layout,
      preview: undefined,
      fields: [
        { id: "name", type: "text", label: "Name" },
        { id: "fetch", type: "action", label: "Fetch models", buttonLabel: "Fetch" },
      ],
    })
    form.setActionState("fetch", { running: true, text: "asking the provider" })
    expect(view().join("\n")).not.toMatch(/[Ee]sc stops it/)
    expect(view().join("\n")).toMatch(/Focus Fetch, then [Ee]sc to stop/)
    form.handleInput(key("tab"))
    expect(view().join("\n")).toMatch(/[Ee]sc stops it/)
  },
)
