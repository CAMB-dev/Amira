import { expect, test } from "bun:test"
import ascii from "../../cli/themes/ascii.json"
import { stripAnsi } from "../src/ansi.ts"
import { CURSOR_MARKER } from "../src/component.ts"
import { Form } from "../src/components/form.ts"
import { defaultGlyphs } from "../src/glyphs.ts"
import { key } from "../src/keys.ts"
import { plain } from "./context.ts"

test("ASCII form chrome covers controls, validation, progress, hints, and truncation", () => {
  const form = new Form({
    title: "A long provider settings title that must truncate at narrow widths",
    fields: [
      {
        id: "protocol",
        type: "select",
        label: "Protocol",
        options: Array.from({ length: 12 }, (_, i) => ({
          value: `protocol-${i}`,
          label: `Long protocol option label ${i}`,
        })),
      },
      { id: "go", type: "action", label: "Fetch models" },
      {
        id: "name",
        type: "text",
        label: "Name",
        placeholder: "A long placeholder that must be truncated in ASCII mode at narrow widths",
      },
      {
        id: "secret",
        type: "secret",
        label: "API key",
        placeholder: "leave empty to keep the current key (stored: auth.json)",
      },
      { id: "tags", type: "multiselect", label: "Models", options: [{ value: "long-model-name" }] },
      { id: "flag", type: "checkbox", label: "Enabled" },
      {
        id: "notes",
        type: "textarea",
        label: "Notes",
        placeholder: "A long notes placeholder that must be truncated in ASCII mode at narrow widths",
      },
    ],
    validate: () => ({ name: "Use lowercase letters." }),
    onSubmit: () => {},
    onCancel: () => {},
  })
  const view = (width = 50, rows = 20) =>
    stripAnsi(
      form.render(width, { ...plain, rows, glyphs: { ...defaultGlyphs, ...ascii.glyphs } }).join("\n"),
    ).replaceAll(CURSOR_MARKER, "")
  const check = (width = 50, rows = 20) => {
    const text = view(width, rows)
    expect([...text].every((char) => char.codePointAt(0)! <= 127)).toBe(true)
    return text
  }
  expect(check()).toContain("left/right change")
  form.handleInput(key("enter"))
  expect(check()).toContain("* Long protocol")
  check(20, 10)
  form.handleInput(key("escape"))
  form.handleInput(key("tab"))
  form.setActionState("go", { running: true })
  expect(check()).toContain("working")
  form.handleInput(key("s", { ctrl: true }))
  expect(check()).toContain("Use lowercase letters.")
  for (let i = 0; i < 5; i++) {
    form.handleInput(key("tab"))
    check()
    check(20, 10)
  }
})
