// A/D deliberate oracles: readable form content starts at column 2; filters use a muted `filter:` label.
import { describe, expect, test } from "bun:test"
import { CURSOR_MARKER } from "../src/component.ts"
import {
  Form,
  type FormFieldView,
  type FormInputValue,
  type FormOptions,
  LineInput,
} from "../src/components/form.ts"
import { FullScreenRenderer } from "../src/fullscreen.ts"
import { defaultGlyphs } from "../src/glyphs.ts"
import { InputParser } from "../src/input.ts"
import { type InputEvent, key, textKey } from "../src/keys.ts"
import { FakeTerminal } from "../src/terminal.ts"
import { visibleWidth } from "../src/width.ts"
import { plain } from "./context.ts"
import { VirtualScreen } from "./screen.ts"

const type = (target: { handleInput(e: InputEvent): boolean }, text: string) => {
  for (const ch of text) target.handleInput(textKey(ch))
}

describe("LineInput", () => {
  test("moves and deletes whole grapheme clusters: CJK, emoji, ZWJ families", () => {
    const input = new LineInput()
    type(input, "a你")
    input.insert("👨‍👩‍👧")
    type(input, "b")
    expect(input.value).toBe("a你👨‍👩‍👧b")
    input.handleInput(key("left"))
    input.handleInput(key("backspace"))
    expect(input.value).toBe("a你b")
    input.handleInput(key("home"))
    input.handleInput(key("delete"))
    expect(input.value).toBe("你b")
  })

  test("pastes on one line; a secret keeps no whitespace; accept filters", () => {
    const text = new LineInput()
    text.handleInput({ type: "paste", text: "one\ntwo\tthree\x07" })
    expect(text.value).toBe("one two three")
    const secret = new LineInput({ mask: "*", accept: (g) => !/\s/.test(g) })
    secret.handleInput({ type: "paste", text: "  sk-abc\r\n" })
    expect(secret.value).toBe("sk-abc")
    expect(secret.render(20, plain.theme)).toBe("******")
    const digits = new LineInput({ accept: (g) => /\d/.test(g) })
    type(digits, "12a3")
    expect(digits.value).toBe("123")
  })

  test("word keys and Ctrl+U/K/W", () => {
    const input = new LineInput()
    input.value = "one two three"
    input.handleInput(key("backspace", { ctrl: true }))
    expect(input.value).toBe("one two ")
    input.handleInput(key("left", { ctrl: true }))
    expect(input.cursor).toBe(4)
    input.handleInput(key("k", { ctrl: true }))
    expect(input.value).toBe("one ")
    input.handleInput(key("u", { ctrl: true }))
    expect(input.value).toBe("")
  })

  test("scrolls sideways to keep the caret in view, counting wide characters as two cells", () => {
    const input = new LineInput()
    input.value = "漢字漢字漢字漢字" // 16 cells
    const line = input.render(9, plain.theme, { focused: true })
    const [before] = line.split(CURSOR_MARKER)
    expect(line.endsWith(CURSOR_MARKER)).toBe(true)
    expect(visibleWidth(before!)).toBeLessThanOrEqual(8)
    input.handleInput(key("home"))
    expect(input.render(9, plain.theme, { focused: true }).startsWith(`${CURSOR_MARKER}漢字`)).toBe(true)
  })
})

const fields = (): FormFieldView[] => [
  { id: "name", type: "text", label: "名前 Name", required: true },
  {
    id: "mode",
    type: "select",
    label: "Mode",
    options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }, { value: "c" }],
  },
  { id: "key", type: "secret", label: "Key" },
  { id: "extra", type: "checkbox", label: "Extra" },
  { id: "more", type: "text", label: "Only with extra" },
  {
    id: "tags",
    type: "multiselect",
    label: "Tags",
    options: [{ value: "x" }, { value: "y" }],
    allowCustom: true,
  },
  { id: "max", type: "number", label: "Max" },
  { id: "go", type: "action", label: "Fetch" },
]

function makeForm(over: Partial<FormOptions> = {}) {
  const log: string[] = []
  let submitted: Record<string, FormInputValue> | undefined
  const form = new Form({
    title: "Provider",
    description: "Add one",
    fields: fields(),
    values: { name: "", mode: "a", tags: [] },
    visible: (f, v) => f.id !== "more" || v.extra === true,
    validate: (v): Record<string, string> => (v.name ? {} : { name: "is required" }),
    onSubmit: (v) => {
      submitted = v
      log.push("submit")
    },
    onCancel: () => log.push("cancel"),
    onAction: (id) => log.push(`action ${id}`),
    onActionCancel: (id) => log.push(`stop ${id}`),
    ...over,
  })
  const view = (rows = 40, width = 50) =>
    form
      .render(width, { ...plain, rows })
      .join("\n")
      .replaceAll(CURSOR_MARKER, "")
  return { form, log, view, submitted: () => submitted }
}

function makeChecklist(
  options: NonNullable<FormFieldView["options"]> = [
    { value: "model-a", label: "Alpha" },
    { value: "model-b", label: "Beta" },
    { value: "model-c", label: "Alpine" },
  ],
  values: string[] = [],
) {
  return makeForm({
    fields: [{ id: "tags", type: "multiselect", label: "Tags", options }],
    values: { tags: values },
    validate: () => ({}),
  })
}

describe("Form", () => {
  test("configured ASCII pointers and separators follow field, list, action and footer focus", () => {
    const { form } = makeForm({
      fields: [
        {
          id: "mode",
          type: "select",
          label: "Mode",
          options: [{ value: "a", label: "Alpha", description: "First" }],
        },
        { id: "tags", type: "multiselect", label: "Tags", options: [{ value: "x" }] },
        { id: "go", type: "action", label: "Fetch" },
      ],
      validate: () => ({}),
    })
    const ctx = { ...plain, rows: 40, glyphs: { ...defaultGlyphs, pointer: ">", separator: "|" } }
    const view = () => form.render(100, ctx).join("\n")
    expect(view()).toContain("> Mode")
    expect(view()).toContain("Alpha ◂▸ | First")
    expect(view()).toContain("enter list | ←→ change | tab/↑↓ move | ctrl+s save | esc cancel")
    form.handleInput(key("enter"))
    expect(view()).toContain("  > ● Alpha")
    form.handleInput(key("escape"))
    form.handleInput(key("tab"))
    expect(view()).toContain("> Tags")
    expect(view()).toContain("  > [ ] x")
    form.handleInput(key("tab"))
    form.setActionState("go", { running: true, text: "Fetching" })
    expect(view()).toContain("> [ Fetch ]")
    expect(view()).toContain("Fetching | esc stops it")
    form.setActionState("go", { running: false })
    form.handleInput(key("tab"))
    expect(view()).toContain("> [ Save ]")
    form.handleInput(key("tab"))
    expect(view()).toContain("> [ Cancel ]")
    expect(view()).not.toMatch(/[›·]/)
    form.setValues({ tags: ["x"] })
    form.handleInput(key("escape"))
    expect(view()).toContain("Discard your changes? y discard | n keep editing")
  })

  test("all field hints use lower-case keys without lower-casing prose or buttons", () => {
    for (const [type, lead] of [
      ["text", "enter next"],
      ["secret", "enter next"],
      ["number", "enter next"],
      ["select", "enter list · ←→ change"],
      [
        "multiselect",
        "space toggle · type to filter · ctrl+a all/none filtered options · ctrl+x invert filtered options",
      ],
      ["checkbox", "space toggle"],
      ["textarea", "shift+enter newline · enter next"],
      ["action", "enter run"],
    ] as const) {
      const form = new Form({
        title: "Provider Settings",
        description: "Keep This Prose",
        fields: [{ id: "field", type, label: "Field Label" }],
        onSubmit: () => {},
        onCancel: () => {},
      })
      const rows = form.render(120, plain)
      const hint = type === "multiselect" ? rows.slice(-2).join(" · ") : rows.at(-1)
      expect(hint).toBe(`${lead} · tab/↑↓ move · ctrl+s save · esc cancel`)
      const text = rows.join("\n")
      expect(text).toContain("Provider Settings")
      expect(text).toContain("Keep This Prose")
      expect(text).toContain("Field Label")
      expect(text).toContain("[ Save ]")
      expect(text).toContain("[ Cancel ]")
    }
  })

  test("Tab, Shift+Tab and ↑↓ walk the fields that show, then Save and Cancel", () => {
    const { form } = makeForm()
    const order: string[] = [form.focused]
    for (let i = 0; i < 8; i++) {
      form.handleInput(key("tab"))
      order.push(form.focused)
    }
    expect(order).toEqual(["name", "mode", "key", "extra", "tags", "max", "go", "submit", "cancel"])
    form.handleInput(key("tab", { shift: true }))
    expect(form.focused).toBe("submit")
    form.handleInput(key("up"))
    expect(form.focused).toBe("go")
    // Checking the box shows the field that depends on it.
    for (const _ of [1, 2, 3]) form.handleInput(key("up"))
    expect(form.focused).toBe("extra")
    form.handleInput(key("space"))
    form.handleInput(key("down"))
    expect(form.focused).toBe("more")
  })

  test("typing edits the focused field and Enter moves on; the secret is never drawn", () => {
    const { form, view } = makeForm()
    type(form, "Ada")
    form.handleInput(key("enter"))
    expect(form.focused).toBe("mode")
    form.handleInput(key("tab"))
    form.handleInput({ type: "paste", text: "sk-live-1234\n" })
    expect(form.values.key).toBe("sk-live-1234")
    expect(view()).not.toContain("sk-live")
    expect(view()).toContain("************ 12 chars")
  })

  test("a select opens with Enter, filters as you type, and Esc closes only the list", () => {
    const { form, view, log } = makeForm()
    form.handleInput(key("tab"))
    form.handleInput(key("right"))
    expect(form.values.mode).toBe("b")
    form.handleInput(key("enter"))
    expect(view()).toContain("› ● Beta")
    expect(view().split("\n").at(-1)).toBe("↑↓ pick · type to filter · enter choose · esc clo…")
    expect(view(40, 80).split("\n").at(-1)).toBe("↑↓ pick · type to filter · enter choose · esc close")
    type(form, "c")
    form.handleInput(key("enter"))
    expect(form.values.mode).toBe("c")
    form.handleInput(key("enter"))
    form.handleInput(key("escape"))
    expect(log).toEqual([])
    expect(view()).not.toContain("Alpha")
  })

  test("a checklist toggles, filters, adds typed and pasted values, and Ctrl+A toggles all", () => {
    const { form, view } = makeForm()
    while (form.focused !== "tags") form.handleInput(key("tab"))
    form.handleInput(key("space"))
    expect(form.values.tags).toEqual(["x"])
    form.handleInput(key("down"))
    form.handleInput(key("enter"))
    expect(form.values.tags).toEqual(["x", "y"])
    type(form, "zeta")
    expect(view()).toContain("enter adds it")
    form.handleInput(key("enter"))
    expect(form.values.tags).toEqual(["x", "y", "zeta"])
    form.handleInput({ type: "paste", text: "p1, p2\np3" })
    expect(form.values.tags).toEqual(["x", "y", "zeta", "p1", "p2", "p3"])
    form.handleInput(key("a", { ctrl: true }))
    expect(form.values.tags).toEqual([])
    // ↓ past the last row leaves the list.
    for (let i = 0; i < 10; i++) form.handleInput(key("down"))
    expect(form.focused).not.toBe("tags")
  })

  test("filtered all/none and invert retain outside selections and report global counts", () => {
    const { form, view } = makeChecklist(undefined, ["model-b"])
    expect(view()).toContain("Tags · selected 1/3")
    expect(view()).toContain("filter: ")
    type(form, "ALP")
    expect(view()).toContain("Tags · selected 1/3 · 2 shown")
    expect(view()).not.toContain("Beta")
    form.handleInput(key("a", { ctrl: true }))
    expect(form.values.tags).toEqual(["model-b", "model-a", "model-c"])
    expect(view()).toContain("selected 3/3 · 2 shown")
    form.handleInput(key("a", { ctrl: true }))
    expect(form.values.tags).toEqual(["model-b"])
    form.handleInput(key("x", { ctrl: true }))
    expect(form.values.tags).toEqual(["model-b", "model-a", "model-c"])
    form.handleInput(key("space"))
    expect(form.values.tags).toEqual(["model-b", "model-c"])
    form.handleInput(key("x", { ctrl: true }))
    expect(form.values.tags).toEqual(["model-b", "model-a"])
    expect(view()).toContain("selected 2/3 · 2 shown")
    form.handleInput(key("x", { ctrl: true }))
    expect(form.values.tags).toEqual(["model-b", "model-c"])
    type(form, "missing")
    expect(view()).toContain("selected 2/3 · 0 shown")
    expect(view()).toContain("no match")
    form.handleInput(key("a", { ctrl: true }))
    form.handleInput(key("x", { ctrl: true }))
    expect(form.values.tags).toEqual(["model-b", "model-c"])
  })

  test("bulk bindings act on every matching option, not just the eight visible rows", () => {
    const matching = Array.from({ length: 12 }, (_, i) => ({ value: `match-${i}` }))
    const { form, view } = makeChecklist([...matching, { value: "outside" }], ["outside"])
    type(form, "match")
    expect(view()).toContain("12 shown")
    expect(view()).not.toContain("match-11")
    form.handleInput(key("a", { ctrl: true }))
    expect(form.values.tags).toEqual(["outside", ...matching.map((o) => o.value)])
    form.handleInput(key("a", { ctrl: true }))
    expect(form.values.tags).toEqual(["outside"])
    form.handleInput(key("x", { ctrl: true }))
    expect(form.values.tags).toEqual(["outside", ...matching.map((o) => o.value)])
    form.handleInput(key("x", { ctrl: true }))
    expect(form.values.tags).toEqual(["outside"])
  })

  test("unfiltered all/none and invert include checked extra rows in the total", () => {
    const { form, view } = makeChecklist(undefined, ["extra"])
    expect(view()).toContain("selected 1/4")
    form.handleInput(key("a", { ctrl: true }))
    expect(form.values.tags).toEqual(["extra", "model-a", "model-b", "model-c"])
    expect(view()).toContain("selected 4/4")
    form.handleInput(key("a", { ctrl: true }))
    expect(form.values.tags).toEqual([])
    expect(view()).toContain("selected 0/3")
    form.handleInput(key("x", { ctrl: true }))
    expect(form.values.tags).toEqual(["model-a", "model-b", "model-c"])
    form.handleInput(key("x", { ctrl: true }))
    expect(form.values.tags).toEqual([])
    form.handleInput(key("space"))
    form.handleInput(key("x", { ctrl: true }))
    expect(form.values.tags).toEqual(["model-b", "model-c"])
    form.handleInput(key("tab"))
    expect(view()).toContain("Tags · selected 2/3")
    expect(view()).not.toContain("filter:")
  })

  test("checklist filters match labels and ids case-insensitively and Esc clears before cancel", () => {
    const { form, view, log } = makeChecklist()
    type(form, "ALP")
    expect(view()).toContain("Alpha")
    expect(view()).toContain("Alpine")
    expect(view()).not.toContain("Beta")
    form.handleInput(key("escape"))
    expect(log).toEqual([])
    expect(view()).toContain("filter: ")
    expect(view()).not.toContain("shown")
    type(form, "MODEL-B")
    expect(view()).toContain("Beta")
    expect(view()).not.toContain("Alpha")
    expect(view()).toContain("1 shown")
    form.handleInput(key("escape"))
    type(form, "é👨‍👩‍👧")
    form.handleInput(key("backspace"))
    expect(view()).toContain("filter: é")
    expect(view()).not.toContain("👨")
    form.handleInput(key("backspace"))
    expect(view()).not.toContain("é")
    expect(view()).not.toContain("shown")
    expect(form.dirty).toBe(false)
    form.handleInput(key("escape"))
    expect(log).toEqual(["cancel"])
  })

  test("empty checklists keep their filter caret and bulk actions are harmless", () => {
    const { form, view } = makeChecklist([])
    expect(view()).toContain("selected 0/0")
    expect(view()).toContain("filter: ")
    expect(view()).toContain("(no options yet)")
    type(form, "missing")
    expect(view()).toContain("selected 0/0 · 0 shown")
    form.handleInput(key("a", { ctrl: true }))
    form.handleInput(key("x", { ctrl: true }))
    expect(form.values.tags).toEqual([])
    expect(form.dirty).toBe(false)
    const lines = form.render(16, { ...plain, rows: 7 })
    expect(lines.some((l) => l.includes(CURSOR_MARKER))).toBe(true)
  })

  test("focused checklist filters mute only the shared filter label, not the query", () => {
    const { form } = makeChecklist()
    type(form, "ALP")
    const lines = form.render(60, {
      ...plain,
      theme: { ...plain.theme, muted: (s) => `\x1b[90m${s}\x1b[39m` },
    })
    const filter = lines.find((l) => l.includes(CURSOR_MARKER))!
    expect(filter).toBe(`  \x1b[90mfilter:\x1b[39m ALP${CURSOR_MARKER}`)
  })

  test("trailing subcolumns align independently across all filtered rows and scroll positions", () => {
    const options = [
      { value: "a", label: "Alpha", detail: ["128k", "$0.27/$1.10"] },
      { value: "b", label: "Beta", detail: ["2M", "$12.50/$24"] },
      { value: "c", label: "Gamma", detail: ["1M"] },
      { value: "d", label: "Unknown" },
      { value: "e", label: "Legacy", detail: "64k" },
      { value: "f", label: "Blank", detail: [] },
      { value: "g", label: "Empty price", detail: ["32k", ""] },
      { value: "h", label: "Other" },
      { value: "i", label: "Wider context", detail: ["1,048,576", "$123.45/$678.90"] },
    ]
    const { form } = makeChecklist(options, ["custom"])
    for (const [width, rows] of [
      [100, 32],
      [60, 24],
    ] as const) {
      const lines = form.render(width, { ...plain, rows })
      const alpha = lines.find((l) => l.includes("[ ] Alpha"))!
      const beta = lines.find((l) => l.includes("[ ] Beta"))!
      const gamma = lines.find((l) => l.includes("[ ] Gamma"))!
      const legacy = lines.find((l) => l.includes("[ ] Legacy"))!
      const edge = alpha.indexOf("128k") + 4
      expect(beta.indexOf("2M") + 2).toBe(edge)
      expect(gamma.indexOf("1M") + 2).toBe(edge)
      expect(legacy.indexOf("64k") + 3).toBe(edge)
      expect(alpha.endsWith("$0.27/$1.10")).toBe(true)
      expect(beta.endsWith("$12.50/$24")).toBe(true)
      expect(visibleWidth(alpha)).toBe(width)
      expect(visibleWidth(beta)).toBe(width)
      expect(lines.find((l) => l.includes("[ ] Unknown"))).not.toContain("undefined")
      for (let i = 0; i < 9; i++) form.handleInput(key("down"))
      const scrolled = form.render(width, { ...plain, rows })
      const widest = scrolled.find((l) => l.includes("[ ] Wider context"))!
      expect(widest.indexOf("1,048,576") + 9).toBe(edge)
      expect(scrolled.join("\n")).toContain("[x] custom")
      for (const line of [...lines, ...scrolled]) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
      for (let i = 0; i < 9; i++) form.handleInput(key("up"))
    }
    type(form, "Alpha")
    const filtered = form.render(60, plain).find((l) => l.includes("[ ] Alpha"))!
    expect(filtered.endsWith("$0.27/$1.10")).toBe(true)
    expect(filtered.indexOf("128k") + 4).toBe(60 - "$0.27/$1.10".length - 2)
  })

  test("narrow subcolumns drop the complete rightmost column before context", () => {
    const { form } = makeChecklist([
      { value: "a", label: "Alpha", detail: ["128k", "$0.27/$1.10"] },
      { value: "b", label: "Wider context", detail: ["1,048,576", "$123.45/$678.90"] },
    ])
    for (const width of [40, 32]) {
      const lines = form.render(width, plain)
      const alpha = lines.find((l) => l.includes("[ ] Alpha"))!
      const wider = lines.find((l) => l.includes("[ ] Wider context"))!
      expect(alpha.endsWith("128k")).toBe(true)
      expect(wider.endsWith("1,048,576")).toBe(true)
      expect(lines.join("\n")).not.toContain("$")
    }
    for (const width of [1, 4, 8, 12, 20]) {
      const lines = form.render(width, plain)
      expect(lines.join("\n")).not.toContain("128k")
      expect(lines.join("\n")).not.toContain("$")
      expect(lines.some((l) => l.includes(CURSOR_MARKER))).toBe(true)
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
    }
  })

  test("generic subcolumns handle wide text and sanitize notes without parsing their content", () => {
    const { form } = makeChecklist([
      { value: "a", label: "Alpha", detail: ["漢字", "short", "第三"] },
      { value: "b", label: "Beta", detail: ["字", "longer\x1b[2J", "👨‍👩‍👧\n"] },
    ])
    const lines = form.render(60, plain)
    const alpha = lines.find((l) => l.includes("[ ] Alpha"))!
    const beta = lines.find((l) => l.includes("[ ] Beta"))!
    expect(visibleWidth(alpha.slice(0, alpha.indexOf("漢字"))) + 4).toBe(
      visibleWidth(beta.slice(0, beta.indexOf("字"))) + 2,
    )
    expect(visibleWidth(alpha.slice(0, alpha.indexOf("short"))) + 5).toBe(
      visibleWidth(beta.slice(0, beta.indexOf("longer"))) + 6,
    )
    expect(visibleWidth(alpha)).toBe(60)
    expect(visibleWidth(beta)).toBe(60)
    expect(beta).not.toContain("\x1b[2J")
    expect(beta).not.toContain("\n")
  })

  test("form headings and descriptions share the field content column", () => {
    const { form } = makeForm({
      title: "Settings",
      description: "Description",
      sections: [{ title: "Connection", help: "Section help" }],
      fields: [{ id: "name", type: "text", label: "Name", section: "Connection" }],
    })
    const lines = form.render(60, plain)
    expect(lines[0]).toMatch(/^ {2}/)
    expect(lines[1]).toBe("  Description")
    expect(lines.find((l) => l.includes("Connection"))).toMatch(/^ {2}/)
    expect(lines.find((l) => l.includes("Section help"))).toBe("  Section help")
    expect(lines.find((l) => l.includes("Name"))).toBe("› Name")
  })

  test("a singleton section matching its field label avoids duplication without hiding controls", () => {
    const { form } = makeForm({
      title: "Settings",
      sections: [{ title: "Models", help: "Choose matching models" }],
      fields: [
        {
          id: "tags",
          type: "multiselect",
          label: "Models",
          section: "Models",
          required: true,
          options: [{ value: "a" }],
        },
      ],
    })
    const lines = form.render(60, plain)
    expect(lines.filter((l) => l.includes("Models"))).toHaveLength(1)
    expect(lines.join("\n")).toContain("› Models * · selected 0/1")
    expect(lines.join("\n")).toContain("Choose matching models")
    expect(lines.join("\n")).toContain("[ ] a")
    expect(lines.some((l) => l.includes(CURSOR_MARKER))).toBe(true)
    const grouped = makeForm({
      fields: [
        { id: "first", type: "text", label: "Connection", section: "Connection" },
        { id: "second", type: "text", label: "URL", section: "Connection" },
      ],
    })
    expect(
      grouped
        .view()
        .split("\n")
        .filter((l) => l.includes("Connection")),
    ).toHaveLength(2)
  })

  test("multiselect details align right while inline descriptions remain supported", () => {
    const { form, view } = makeChecklist([
      { value: "a", label: "Alpha", description: "first", detail: "128k" },
      { value: "b", label: "Beta", detail: "2M" },
      { value: "c", label: "Gamma", description: "third" },
      { value: "d", label: "Delta", detail: "" },
    ])
    const lines = form.render(50, { ...plain, rows: 40 })
    const alpha = lines.find((l) => l.includes("[ ] Alpha"))!
    const beta = lines.find((l) => l.includes("[ ] Beta"))!
    expect(alpha).toContain("Alpha  first")
    expect(alpha.endsWith("128k")).toBe(true)
    expect(beta.endsWith("2M")).toBe(true)
    expect(visibleWidth(alpha)).toBe(50)
    expect(visibleWidth(beta)).toBe(50)
    expect(view()).toContain("Gamma  third")
    expect(view()).not.toContain("undefined")
    form.setOptions("tags", [{ value: "a", label: "Alpha", detail: "updated" }])
    expect(view()).toContain("updated")
  })

  test("detail columns and empty states stay width-bounded in narrow terminals", () => {
    const { form } = makeChecklist([
      { value: "a", label: "Long model label", detail: "Context info with a long price" },
      { value: "b", label: "漢字 model", detail: "128k 👨‍👩‍👧" },
      { value: "c", label: "Short", description: "legacy description", detail: "" },
    ])
    for (const width of [1, 4, 8, 10, 12, 16, 24, 50]) {
      const lines = form.render(width, { ...plain, rows: 40 })
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
      expect(lines.some((l) => l.includes(CURSOR_MARKER))).toBe(true)
    }
    const narrow = form.render(16, { ...plain, rows: 40 }).join("\n")
    expect(narrow).toContain("Lo…")
    expect(narrow).toContain("Co…")
    const empty = makeChecklist([])
    for (const width of [1, 4, 8, 12]) {
      for (const line of empty.form.render(width, { ...plain, rows: 40 }))
        expect(visibleWidth(line)).toBeLessThanOrEqual(width)
    }
    type(form, "a very long query with 漢字")
    const filter = form.render(16, { ...plain, rows: 40 }).find((l) => l.includes(CURSOR_MARKER))!
    expect(visibleWidth(filter.split(CURSOR_MARKER)[0]!)).toBeLessThan(16)
  })

  test("bulk actions and filter changes retain the scrolled highlight and active row", () => {
    const { form, view } = makeChecklist(
      Array.from({ length: 14 }, (_, i) => ({ value: `id-${i}`, label: `Group ${i}` })),
    )
    for (let i = 0; i < 11; i++) form.handleInput(key("down"))
    expect(view()).toContain("› [ ] Group 11")
    expect(view()).toContain("12/14")
    form.handleInput(key("a", { ctrl: true }))
    expect(view()).toContain("› [x] Group 11")
    form.handleInput(key("x", { ctrl: true }))
    expect(view()).toContain("› [ ] Group 11")
    expect(view()).toContain("12/14")
    type(form, "GROUP")
    expect(view()).toContain("› [ ] Group 11")
    form.handleInput(key("escape"))
    expect(view()).toContain("› [ ] Group 11")
    type(form, "ID-11")
    expect(view()).toContain("› [ ] Group 11")
    form.handleInput(key("escape"))
    expect(view()).toContain("› [ ] Group 11")
    const short = form.render(50, { ...plain, rows: 9 }).join("\n")
    expect(short).toContain("› [ ] Group 11")
    form.handleInput(key("space"))
    expect(form.values.tags).toEqual(["id-11"])
  })

  test("bulk key hints remain visible at walkthrough widths", () => {
    const { form } = makeChecklist([{ value: "a" }])
    for (const [width, rows] of [
      [100, 32],
      [60, 24],
    ] as const) {
      const lines = form.render(width, { ...plain, rows })
      const view = lines.join("\n")
      expect(lines.some((l) => l.includes("ctrl+a all/none filtered options"))).toBe(true)
      expect(lines.some((l) => l.includes("ctrl+x invert filtered options"))).toBe(true)
      expect(view).toContain("esc cancel")
      expect(view).toContain("filter:")
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
    }
  })

  test("bulk shortcuts stay local and global save/cancel still win over field bindings", () => {
    const { form, log, submitted } = makeForm({
      fields: [
        { id: "name", type: "text", label: "Name" },
        { id: "tags", type: "multiselect", label: "Tags", options: [{ value: "a" }, { value: "b" }] },
        { id: "notes", type: "textarea", label: "Notes" },
      ],
      values: { tags: ["a"] },
      validate: () => ({}),
    })
    type(form, "Ada")
    form.handleInput(key("a", { ctrl: true }))
    type(form, "!")
    expect(form.values.name).toBe("!Ada")
    form.handleInput(key("x", { ctrl: true }))
    expect(form.values.tags).toEqual(["a"])
    form.handleInput(key("tab"))
    form.handleInput(key("x", { ctrl: true }))
    expect(form.values.tags).toEqual(["b"])
    form.handleInput(key("tab"))
    type(form, "Note")
    form.handleInput(key("a", { ctrl: true }))
    type(form, "!")
    expect(form.values.notes).toBe("!Note")
    form.handleInput(key("x", { ctrl: true }))
    expect(form.values.tags).toEqual(["b"])
    form.handleInput(key("tab", { shift: true }))
    type(form, "b")
    form.handleInput(key("s", { ctrl: true }))
    expect(log).toEqual(["submit"])
    expect(submitted()?.tags).toEqual(["b"])
    expect(form.values.tags).toEqual(["b"])
    type(form, "a")
    form.handleInput(key("c", { ctrl: true }))
    expect(form.confirmingCancel).toBe(true)
    form.handleInput(key("y"))
    expect(log).toEqual(["submit", "cancel"])
  })

  test("problems show once a field is left, and saving goes to the first one", () => {
    const { form, view, log } = makeForm()
    expect(view()).not.toContain("is required")
    form.handleInput(key("tab"))
    expect(view()).toContain("✗ is required")
    form.handleInput(key("s", { ctrl: true }))
    expect(log).toEqual([])
    expect(form.focused).toBe("name")
    expect(view()).toContain("Fix 1 field before saving.")
    type(form, "a")
    form.handleInput(key("s", { ctrl: true }))
    expect(log).toEqual(["submit"])
  })

  test("Esc cancels at once when nothing changed, and asks first when something did", () => {
    const clean = makeForm()
    clean.form.handleInput(key("escape"))
    expect(clean.log).toEqual(["cancel"])

    const { form, log, view } = makeForm()
    type(form, "x")
    form.handleInput(key("escape"))
    expect(form.confirmingCancel).toBe(true)
    expect(view()).toContain("Discard your changes?")
    // Keys other than y/n/Esc/Enter do nothing while asking.
    type(form, "q")
    expect(form.values.name).toBe("x")
    form.handleInput(key("n"))
    expect(log).toEqual([])
    form.handleInput(key("c", { ctrl: true }))
    form.handleInput(key("y"))
    expect(log).toEqual(["cancel"])
  })

  test("buttons: Enter runs an action, Esc stops a running one, and its result shows", () => {
    const { form, log, view } = makeForm()
    while (form.focused !== "go") form.handleInput(key("tab"))
    form.handleInput(key("enter"))
    expect(log).toEqual(["action go"])
    form.setActionState("go", { running: true, text: "fetching" })
    form.handleInput(key("enter"))
    expect(log).toEqual(["action go"])
    expect(view()).toContain("… fetching · esc stops it")
    expect(view().split("\n").at(-1)).toBe("esc stop · tab/↑↓ move · ctrl+s save")
    form.handleInput(key("escape"))
    expect(log).toEqual(["action go", "stop go"])
    form.setActionState("go", { running: false, text: "Found 2 models", tone: "success" })
    form.setOptions("tags", [{ value: "m1", description: "128k" }, { value: "m2" }])
    form.setValues({ max: 64 })
    expect(view()).toContain("Found 2 models")
    expect(form.values.max).toBe(64)
  })

  test("a short terminal scrolls the body to the focused field and keeps the buttons", () => {
    const { form } = makeForm()
    const rows = 9
    while (form.focused !== "max") form.handleInput(key("tab"))
    const lines = form.render(40, { ...plain, rows })
    expect(lines.length).toBe(rows)
    expect(lines.join("\n")).toContain("› Max")
    expect(lines.join("\n")).toContain("[ Save ]")
    expect(lines.join("\n")).toContain("↑")
    // Tiny: still a title, a body row and the buttons.
    const tiny = form.render(20, { ...plain, rows: 4 })
    expect(tiny.length).toBe(4)
    expect(tiny.some((l) => l.includes("Save"))).toBe(true)
  })

  test("keys from Windows Terminal (win32-input-mode) and kitty reach the form the same", () => {
    const win32 = (vk: number, uc: number, cs: number) => `\x1b[${vk};0;${uc};1;${cs};1_`
    for (const [tab, shiftTab, esc] of [
      [win32(9, 9, 0), win32(9, 9, 0x10), win32(27, 27, 0)],
      ["\x1b[9u", "\x1b[9;2u", "\x1b[27u"],
    ] as const) {
      const { form, log } = makeForm()
      const parser = new InputParser()
      const feed = (s: string) => {
        for (const e of parser.feed(s)) form.handleInput(e)
      }
      feed(tab)
      expect(form.focused).toBe("mode")
      feed(shiftTab)
      expect(form.focused).toBe("name")
      feed(esc)
      expect(log).toEqual(["cancel"])
    }
  })

  test("on the alternate screen the terminal cursor sits at the caret, and moves with resizes", () => {
    const term = new FakeTerminal(40, 16)
    const screen = new VirtualScreen(40, 16)
    const write = term.write.bind(term)
    term.write = (d: string) => {
      write(d)
      screen.write(d)
    }
    const { form } = makeForm()
    const full = new FullScreenRenderer(term, form)
    full.open()
    type(form, "你好")
    full.render()
    expect(screen.cursorVisible).toBe(true)
    const row = screen.lines.findIndex((l) => l.includes("你好"))
    expect(screen.y).toBe(row)
    expect(screen.x).toBe(2 + 4)
    screen.resize(30, 10)
    term.setSize(30, 10)
    full.render()
    expect(screen.lines.some((l) => l.includes("你好"))).toBe(true)
    // Focus on a button: no caret, so the cursor hides.
    while (form.focused !== "submit") form.handleInput(key("tab"))
    full.render()
    expect(screen.cursorVisible).toBe(false)
    full.close()
    expect(screen.inAltScreen).toBe(false)
  })
})
