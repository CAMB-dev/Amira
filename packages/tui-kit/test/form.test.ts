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

describe("Form", () => {
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
    expect(view()).toContain("Enter adds it")
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
    expect(view()).toContain("… fetching · Esc stops it")
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
    expect(screen.x).toBe(3 + 4)
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
