import { expect, test } from "bun:test"
import { Form } from "../src/components/form.ts"
import { key, textKey } from "../src/keys.ts"
import { plain } from "./context.ts"

function providerForm() {
  const saved: string[] = []
  const form = new Form({
    title: "Provider",
    fields: [
      { id: "id", type: "text", label: "Id" },
      { id: "key", type: "secret", label: "API key" },
      { id: "fetch", type: "action", label: "Fetch models" },
    ],
    values: { id: "Bad" },
    validate: (values) => {
      const errors: Record<string, string> = {}
      if (!/^[a-z-]+$/.test(String(values.id))) errors.id = "Use lowercase letters."
      if (!values.key) errors.key = "Enter a key."
      return errors
    },
    onSubmit: (values) => saved.push(String(values.id)),
    onCancel: () => {},
  })
  const view = () => form.render(100, { ...plain, rows: 30 }).join("\n")
  return { form, saved, view }
}

test("real form recomputes the submit summary while invalid fields are corrected", () => {
  const { form, saved, view } = providerForm()
  form.handleInput(key("s", { ctrl: true }))
  expect(view()).toContain("Fix 2 fields before saving.")
  expect(saved).toEqual([])
  form.handleInput(key("u", { ctrl: true }))
  for (const char of "ui-walk-demo") form.handleInput(textKey(char))
  expect(view()).not.toContain("Use lowercase letters.")
  expect(view()).toContain("Fix 1 field before saving.")
  expect(view()).not.toContain("Fix 2 fields")
  form.handleInput(key("tab"))
  form.handleInput({ type: "paste", text: "fake-token" })
  form.setActionState("fetch", { running: false, text: "200 models listed", tone: "success" })
  expect(view()).toContain("200 models listed")
  expect(view()).not.toContain("before saving.")
  expect(saved).toEqual([])
  form.handleInput(key("s", { ctrl: true }))
  expect(saved).toEqual(["ui-walk-demo"])
})

test("external validation and option/value updates keep summaries separate from action status", () => {
  const { form, view } = providerForm()
  form.setErrors({ id: "Server rejected Id", key: "Enter a key." })
  form.setStatus("Models fetched", "success")
  expect(view()).toContain("Fix 2 fields before saving.")
  expect(view()).toContain("Models fetched")
  form.setValues({ id: "valid", key: "fake-token" })
  expect(view()).not.toContain("before saving.")
  expect(view()).toContain("Models fetched")
  form.setValues({ id: "Bad" })
  expect(view()).toContain("Fix 1 field before saving.")
  form.setValues({ id: "valid" })
  form.setOptions("fetch", [])
  expect(view()).not.toContain("before saving.")
  expect(view()).toContain("Models fetched")
})
