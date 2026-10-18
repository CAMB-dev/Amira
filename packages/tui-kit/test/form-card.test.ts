import { describe, expect, test } from "bun:test"
import ascii from "../../cli/themes/ascii.json"
import { stripAnsi } from "../src/ansi.ts"
import { CURSOR_MARKER } from "../src/component.ts"
import { Form, type FormOptions } from "../src/components/form.ts"
import { defaultGlyphs } from "../src/glyphs.ts"
import { key, type MouseInput } from "../src/keys.ts"
import { visibleWidth } from "../src/width.ts"
import { plain } from "./context.ts"

function make(over: Partial<FormOptions> = {}) {
  const events: string[] = []
  const form = new Form({
    title: "Add provider",
    layout: "card",
    fields: [
      { id: "vendor", type: "select", label: "Vendor", options: [{ value: "custom" }] },
      { id: "name", type: "text", label: "Name", required: true },
      { id: "secret", type: "secret", label: "API key" },
      { id: "fetch", type: "action", label: "Fetch models" },
      { id: "extra", type: "text", label: "Headers", section: "Advanced" },
      { id: "test", type: "action", label: "Test connection", placement: "footer", buttonLabel: "Test" },
    ],
    sections: [{ title: "Advanced", collapsed: true }],
    onSubmit: () => events.push("save"),
    onCancel: () => events.push("cancel"),
    onAction: (id) => events.push(id),
    ...over,
  })
  const render = (width = 120, rows = 36) => form.render(width, { ...plain, rows })
  const view = (width = 120, rows = 36) => render(width, rows).map(clean)
  return { form, events, render, view }
}

const clean = (line: string) => stripAnsi(line).replaceAll(CURSOR_MARKER, "")
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
const click = (form: Form, x: number, y: number) => {
  form.handleInput(mouse("press", x, y))
  form.handleInput(mouse("release", x, y))
}
const target = (lines: string[], text: string) => {
  const y = lines.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  return { x: lines[y]!.indexOf(text), y }
}
const focus = (form: Form, id: string) => {
  for (let i = 0; i < 100 && form.focused !== id; i++) form.handleInput(key("tab"))
  expect(form.focused).toBe(id)
}

describe("opt-in form card", () => {
  for (const [width, rows, expectedWidth] of [
    [120, 36, 88],
    [80, 24, 72],
    [61, 21, 53],
  ] as const) {
    test(`centres its content-sized frame at ${width}x${rows}`, () => {
      const { view } = make()
      const lines = view(width, rows)
      const top = lines.findIndex((line) => line.includes("╭"))
      const bottom = lines.findIndex((line) => line.includes("╰"))
      const height = bottom - top + 1
      const left = Math.floor((width! - expectedWidth!) / 2)
      expect(lines).toHaveLength(rows!)
      expect(top).toBe(Math.floor((rows! - height) / 2))
      expect(height).toBeLessThanOrEqual(rows! - 4)
      expect(height).toBeLessThan(rows! - 4) // This short form does not stretch to fill the screen.
      expect(lines[top]!.indexOf("╭")).toBe(left)
      expect(lines[top]).toContain("Add provider")
      for (const line of lines.slice(top, bottom + 1)) expect(visibleWidth(line) - left).toBe(expectedWidth!)
      const name = target(lines, "Name *")
      const vendor = target(lines, "Vendor")
      expect(name.x).toBe(vendor.x) // Labels align on the left, not the old right edge.
      expect(lines[name.y]!.indexOf("│", left + 1)).toBe(lines[vendor.y]!.indexOf("│", left + 1))
      expect(lines[name.y - 1]).toContain("┼")
      expect(lines.join("\n")).toContain("[ Test ]")
    })
  }

  for (const [width, rows] of [
    [120, 36],
    [80, 24],
    [61, 21],
  ] as const) {
    test(`keeps every card row bordered and the footer hint inset at ${width}x${rows}`, () => {
      const { form, view } = make({
        description: "Provider settings help ".repeat(12),
        preview: () => Array.from({ length: 40 }, (_, i) => `settings preview line ${i}`),
      })
      const checkBorders = () => {
        const lines = view(width, rows)
        const cardWidth = Math.min(width - 8, 88)
        const left = Math.floor((width - cardWidth) / 2)
        const top = lines.findIndex((line) => line[left] === "╭")
        const bottom = lines.findIndex((line) => line[left] === "╰")
        expect(top).toBeGreaterThanOrEqual(0)
        expect(bottom).toBeGreaterThan(top)
        for (const line of lines.slice(top + 1, bottom)) {
          const cardRow = line.slice(left)
          expect(cardRow.startsWith("│")).toBe(true)
          expect(cardRow.endsWith("│")).toBe(true)
          expect(visibleWidth(cardRow)).toBe(cardWidth)
        }
        return { lines, left }
      }
      const { lines, left } = checkBorders()
      const hint = target(lines, width >= 80 ? "↑↓/Tab" : "^S save")
      const button = target(lines, "[ Test ]")
      expect(hint.x).toBe(button.x)
      expect(hint.x).toBe(left + 3)
      form.setErrors({ name: "Invalid provider name" })
      checkBorders()
      focus(form, "\0section:Advanced")
      form.handleInput(key("enter"))
      checkBorders()
      form.handleInput(key("p", { ctrl: true }))
      form.handleInput(key("pagedown"))
      checkBorders()
    })
  }

  for (const [width, rows] of [
    [120, 36],
    [80, 24],
    [61, 21],
  ] as const) {
    test(`insets consistent coloured hints without clipping card borders at ${width}x${rows}`, () => {
      const { form } = make({
        fields: [{ id: "models", type: "multiselect", label: "Models", options: [{ value: "demo" }] }],
      })
      const lines = form
        .render(width, {
          ...plain,
          rows,
          color: true,
          theme: { ...plain.theme, muted: (s) => `\x1b[90m${s}\x1b[39m` },
        })
        .map(clean)
      const left = Math.floor((width - Math.min(width - 8, 88)) / 2)
      const top = lines.findIndex((line) => line[left] === "╭")
      const bottom = lines.findIndex((line) => line[left] === "╰")
      for (const line of lines.slice(top + 1, bottom)) {
        expect(line.slice(left).startsWith("│")).toBe(true)
        expect(line.endsWith("│")).toBe(true)
        expect(visibleWidth(line) - left).toBe(Math.min(width - 8, 88))
      }
      const button = target(lines, "[ Save ]")
      expect(bottom - button.y).toBe(2)
      for (const line of lines.slice(button.y + 1, bottom)) {
        expect(line.slice(left + 1, left + 3)).toBe("  ")
        expect(line[left + 3]).not.toBe(" ")
      }
    })
  }

  for (const [width, rows] of [
    [59, 36],
    [120, 19],
    [40, 12],
  ] as const) {
    test(`falls back to plain form at ${width}x${rows}`, () => {
      const lines = make().view(width, rows)
      expect(lines.join("\n")).not.toContain("╭")
      expect(lines[0]).toContain("Add provider")
      expect(lines.join("\n")).toContain("[ Test ]")
      expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true)
    })
  }

  test("leaves other forms in the existing presentation", () => {
    const { form, view } = make({ layout: undefined })
    expect(form.cardLayout).toBe(false)
    expect(view().join("\n")).not.toContain("╭")
  })

  test("uses themed ASCII borders and highlights the focused row with a theme token", () => {
    const { form } = make()
    const text = form
      .render(80, { ...plain, rows: 24, glyphs: { ...defaultGlyphs, ...ascii.glyphs } })
      .map(clean)
      .join("\n")
    expect([...text].every((char) => char.codePointAt(0)! <= 127)).toBe(true)
    const rows = form.render(120, {
      ...plain,
      rows: 36,
      color: true,
      theme: { ...plain.theme, inputBg: (s) => `\x1b[7m${s}\x1b[27m` },
    })
    const vendor = rows.find((line) => line.includes("Vendor"))!
    const name = rows.find((line) => line.includes("Name"))!
    expect(vendor.indexOf("\x1b[7m")).toBeLessThan(vendor.indexOf("Vendor"))
    expect(name.indexOf("\x1b[7m")).toBeGreaterThan(name.indexOf("Name"))
  })

  test("scrolls only inside the card by wheel and keyboard, with fixed borders and footer", () => {
    const { form, view } = make({
      fields: Array.from({ length: 24 }, (_, i) => ({ id: `f${i}`, type: "text", label: `Field ${i}` })),
    })
    const before = view(80, 24)
    const edge = before.findIndex((line) => line.includes("╭"))
    const footer = target(before, "[ Save ]")
    const first = target(before, "Field 0")
    form.handleInput(mouse("wheel", first.x, first.y, "down"))
    const after = view(80, 24)
    expect(after[edge]).toBe(before[edge])
    expect(target(after, "[ Save ]")).toEqual(footer)
    expect(after.join("\n")).not.toContain("Field 0 ")
    expect(form.focused).toBe("f0") // Wheel scrolling does not edit or move focus.
    form.handleInput(key("pagedown"))
    expect(view(80, 24)).not.toEqual(after)
    expect(form.focused).toBe("f0") // Page keys scroll the body, not its field focus.
    focus(form, "f23")
    expect(view(80, 24).join("\n")).toContain("Field 23")
    expect(target(view(80, 24), "[ Save ]")).toEqual(footer)
    const atEnd = view(80, 24)
    form.handleInput(mouse("wheel", 0, first.y, "up"))
    expect(view(80, 24)).toEqual(atEnd) // Even wheel input outside the frame is inert.
    const last = target(atEnd, "Field 23")
    click(form, last.x, last.y)
    form.handleInput({ type: "paste", text: "edited after scrolling" })
    expect(form.values.f23).toBe("edited after scrolling")
  })

  test("places errors under the input, inside the same grid row", () => {
    const { form, view } = make({ validate: () => ({ name: "Name is required" }) })
    form.handleInput(key("s", { ctrl: true }))
    const lines = view()
    const name = target(lines, "Name *")
    const error = target(lines, "Name is required")
    expect(error.y).toBe(name.y + 1)
    const divider = lines[name.y]!.indexOf("│", lines[name.y]!.indexOf("│") + 1)
    expect(error.x).toBeGreaterThan(divider)
    expect(lines[error.y]![divider]).toBe("│")
    expect(lines[error.y + 1]).toContain("┼")
    expect(form.focused).toBe("name")
  })

  test("Tab order ends with Test, Save, Cancel; Enter/Space use existing action and submit paths", () => {
    const { form, events, view } = make({ preview: () => ["settings.json", "key: auth.json (masked)"] })
    view()
    const order = ["vendor", "name", "secret", "fetch", "\0section:Advanced", "test", "submit", "cancel"]
    for (let i = 0; i < order.length; i++) {
      expect(form.focused).toBe(order[i]!)
      if (form.focused === "test") form.handleInput(key("space"))
      if (form.focused === "submit") form.handleInput(key("enter"))
      form.handleInput(key("tab"))
    }
    expect(events).toEqual(["test", "save"])
    form.handleInput(key("tab", { shift: true }))
    expect(form.focused).toBe("submit")
    form.handleInput(key("tab"))
    form.handleInput(key("space"))
    expect(events).toEqual(["test", "save", "cancel"])
  })

  test("clicks rows, inputs, disclosure, in-row actions and each footer button", () => {
    const { form, events, view } = make()
    let lines = view()
    let hit = target(lines, "Name *")
    click(form, hit.x, hit.y)
    expect(form.focused).toBe("name")
    form.handleInput({ type: "paste", text: "abc" })
    lines = view()
    hit = target(lines, "abc")
    click(form, hit.x + 1, hit.y)
    form.handleInput({ type: "paste", text: "!" })
    expect(form.values.name).toBe("a!bc")
    lines = view()
    hit = target(lines, "Advanced")
    click(form, hit.x, hit.y)
    expect(view().join("\n")).toContain("Headers")
    lines = view()
    for (const label of ["[ Fetch models ]", "[ Test ]", "[ Save ]"]) {
      hit = target(lines, label)
      click(form, hit.x + 2, hit.y)
      lines = view()
    }
    expect(events).toEqual(["fetch", "test", "save"])
    hit = target(lines, "[ Cancel ]")
    click(form, hit.x + 2, hit.y)
    expect(form.confirmingCancel).toBe(true)
    expect(form.values.name).toBe("a!bc")
  })

  test("empty cards keep buttons and their click targets on the same rows", () => {
    const { form, events, view } = make({ fields: [] })
    const lines = view()
    const save = target(lines, "[ Save ]")
    click(form, save.x + 2, save.y)
    const cancel = target(lines, "[ Cancel ]")
    click(form, cancel.x + 2, cancel.y)
    expect(events).toEqual(["save", "cancel"])
  })

  test("fallback wraps footer actions so Cancel remains visible and clickable", () => {
    const { form, events, view } = make()
    const lines = view(32, 24)
    const save = target(lines, "[ Save ]")
    const cancel = target(lines, "[ Cancel ]")
    expect(cancel.y).toBeGreaterThan(save.y)
    click(form, cancel.x + 2, cancel.y)
    expect(events).toEqual(["cancel"])
    expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true)
  })

  test("body actions honor a short button label without changing the row label", () => {
    const { view } = make({
      fields: [{ id: "test", type: "action", label: "Test connection", buttonLabel: "Test" }],
    })
    const lines = view()
    expect(lines.join("\n")).toContain("Test connection")
    expect(lines.join("\n")).toContain("[ Test ]")
    expect(lines.join("\n")).not.toContain("[ Test connection ]")
  })

  test("Esc and Cancel retain dirty input until discard is confirmed; click outside is inert", () => {
    const { form, events, view } = make()
    view()
    focus(form, "name")
    form.handleInput({ type: "paste", text: "unsaved" })
    view()
    click(form, 0, 0)
    click(form, 119, 18)
    expect(form.focused).toBe("name")
    expect(form.confirmingCancel).toBe(false)
    form.handleInput(key("escape"))
    expect(form.confirmingCancel).toBe(true)
    view()
    click(form, 0, 0)
    expect(form.confirmingCancel).toBe(true)
    form.handleInput(key("escape"))
    expect(form.confirmingCancel).toBe(false)
    expect(form.values.name).toBe("unsaved")
    expect(events).toEqual([])
    form.handleInput(key("escape"))
    const hit = target(view(), "n keep editing")
    click(form, hit.x + 2, hit.y)
    expect(form.confirmingCancel).toBe(false)
    expect(form.values.name).toBe("unsaved")
  })
})
