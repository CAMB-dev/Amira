import type { InputEvent } from "../keys.ts"
import { graphemes } from "../width.ts"
import { Editor } from "./editor.ts"
import type { FormChoice, FormFieldView, FormInputValue } from "./form.ts"
import type { FormFieldState as FieldState } from "./form-field.ts"
import { LineInput } from "./line-input.ts"

export function makeFormField(def: FormFieldView, initial: FormInputValue | undefined): FieldState {
  const f: FieldState = {
    def,
    value: "",
    options: [...(def.options ?? [])],
    open: false,
    highlight: 0,
    top: 0,
    filter: "",
  }
  switch (def.type) {
    case "text":
      f.input = new LineInput()
      break
    case "secret":
      // "*" is one cell everywhere; "•" is ambiguous-width and takes two in some CJK setups.
      f.input = new LineInput({ mask: "*", accept: (g) => !/\s/.test(g) })
      break
    case "number":
      f.input = new LineInput({ accept: (g) => /[0-9.,_-]/.test(g) })
      break
    case "textarea":
      f.editor = new Editor({ placeholder: def.placeholder ?? "" })
      f.editor.maxRows = def.rows ?? 4
      break
    case "select":
      f.value = typeof initial === "string" ? initial : (f.options[0]?.value ?? "")
      break
    case "multiselect":
      f.value = Array.isArray(initial) ? [...initial] : []
      break
    case "checkbox":
      f.value = initial === true
      break
    case "action":
      f.action = { running: false }
      break
  }
  if (f.input && initial !== undefined) f.input.value = String(initial)
  if (f.editor && initial !== undefined) f.editor.setText(String(initial))
  return f
}

export function formFieldValue(f: FieldState): FormInputValue | undefined {
  switch (f.def.type) {
    case "text":
    case "secret":
      return f.input!.value
    case "number": {
      const raw = f.input!.value.trim()
      if (!raw) return undefined
      const n = Number(raw.replace(/[_,]/g, ""))
      return Number.isFinite(n) ? n : raw
    }
    case "textarea":
      return f.editor!.getText()
    case "multiselect":
      return [...(f.value as string[])]
    case "action":
      return undefined
    default:
      return f.value
  }
}

export function setFormFilter(f: FieldState, filter: string): void {
  const highlighted = f.def.type === "multiselect" ? formChecklistRows(f)[f.highlight]?.value : undefined
  f.filter = filter
  const next = highlighted === undefined ? -1 : formChecklistRows(f).findIndex((r) => r.value === highlighted)
  f.highlight = Math.max(0, next)
  if (next < 0) f.top = 0
}

export function filteredFormChoices(f: FieldState): FormChoice[] {
  const q = f.filter.toLowerCase()
  if (!q) return f.options
  return f.options.filter((o) => `${o.value} ${o.label ?? ""} ${o.group ?? ""}`.toLowerCase().includes(q))
}

/** A checklist's rows: its options, then checked values that are no options, filtered. */
export function formChecklistRows(f: FieldState, filter = f.filter): FormChoice[] {
  const extra = (f.value as string[])
    .filter((v) => !f.options.some((o) => o.value === v))
    .map((value) => ({ value }))
  const all: FormChoice[] = [...f.options, ...extra]
  const q = filter.toLowerCase()
  return q ? all.filter((o) => `${o.value} ${o.label ?? ""} ${o.group ?? ""}`.toLowerCase().includes(q)) : all
}

/** Control characters, including tabs and line breaks, that a one-line input never keeps. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const CONTROL = /[\x00-\x1f\x7f\x9b]/g

/** Typing into a list's filter; false for keys that are not typing. */
export function filterFormInput(f: FieldState, e: InputEvent): boolean {
  if (e.type === "focus" || e.type === "mouse") return false
  let filter = f.filter
  if (e.type === "paste") filter += e.text.replace(/\s+/g, "").replace(CONTROL, "")
  else if (e.name === "backspace" && !e.ctrl && !e.alt) {
    if (!filter) return false
    filter = graphemes(filter).slice(0, -1).join("")
  } else if (e.text && !e.ctrl && !e.alt && e.name !== "space") filter += e.text
  else return false
  setFormFilter(f, filter)
  return true
}
