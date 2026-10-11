import { type Component, CURSOR_MARKER, type RenderContext } from "../component.ts"
import { type InputEvent, isSubmitKey, keyLabel, matchesKey } from "../keys.ts"
import { bold, inverse, type Theme } from "../style.ts"
import { graphemes, truncateToWidth, visibleWidth, wrapText } from "../width.ts"
import { Editor } from "./editor.ts"
import { LineInput } from "./line-input.ts"

export { LineInput, type LineInputOptions } from "./line-input.ts"

/** Control characters, including tabs and line breaks, that a one-line input never keeps. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const CONTROL = /[\x00-\x1f\x7f\x9b]/g

/** A value of one form field. */
export type FormInputValue = string | number | boolean | string[]

export interface FormChoice {
  value: string
  label?: string
  description?: string
}

export type FormFieldKind =
  | "text"
  | "secret"
  | "number"
  | "select"
  | "multiselect"
  | "checkbox"
  | "textarea"
  | "action"

/** One field as the form shows it. */
export interface FormFieldView {
  id: string
  type: FormFieldKind
  label: string
  help?: string
  section?: string
  required?: boolean
  placeholder?: string
  /** For select and multiselect. */
  options?: FormChoice[]
  /** A multiselect takes values that are not options (typed into its filter). */
  allowCustom?: boolean
  /** Rows a textarea shows. Default 4. */
  rows?: number
}

export type FormStatusTone = "info" | "success" | "warning" | "error"

export interface FormOptions {
  title: string
  description?: string
  fields: FormFieldView[]
  sections?: { title: string; help?: string }[]
  /** Default "Save". */
  submitLabel?: string
  /** Starting values by field id. */
  values?: Record<string, FormInputValue>
  /** Whether a field shows for these values. Default: all do. */
  visible?: (field: FormFieldView, values: Record<string, FormInputValue>) => boolean
  /** Problems by field id; shown for fields the user has left, and for all after a save attempt. */
  validate?: (values: Record<string, FormInputValue>) => Record<string, string>
  onSubmit: (values: Record<string, FormInputValue>) => void
  onCancel: () => void
  /** An action button was pressed. */
  onAction?: (id: string, values: Record<string, FormInputValue>) => void
  /** Esc on a running action. */
  onActionCancel?: (id: string) => void
  /** Warning lines above the buttons, e.g. dialogs waiting behind the form. */
  notice?: () => string[]
}

interface ActionState {
  running: boolean
  text?: string
  tone?: FormStatusTone
}

interface FieldState {
  def: FormFieldView
  input?: LineInput
  editor?: Editor
  /** select: the chosen value; multiselect: the checked values; checkbox: on or off. */
  value: FormInputValue
  options: FormChoice[]
  /** A select shows its list. */
  open: boolean
  /** Highlighted row of a select's list or a checklist. */
  highlight: number
  /** First row shown of a long list. */
  top: number
  filter: string
  action?: ActionState
}

interface Span {
  start: number
  end: number
  /** The line with the caret or the highlighted row. */
  active: number
}

const SUBMIT = "\0submit"
const CANCEL = "\0cancel"
/** List rows shown at once; longer lists scroll with the highlight. */
const LIST_ROWS = 8
const INDENT = "   "
/** Before the focused field, the highlighted option and the focused button: the selection marker everywhere. */
const POINTER = "❯"

/**
 * A full-screen form: a title, a scrolling body of fields and buttons, and a footer with
 * Save and Cancel. Tab/Shift+Tab or ↓/↑ move between fields; typing edits the focused text
 * field and Enter moves on; Enter or Space opens a select, toggles a checkbox or a checklist
 * row, and presses a button; Ctrl+S saves from anywhere. Esc first closes what the field has
 * open (a select's list, a checklist filter, a running action), and otherwise cancels the
 * form, asking first when something changed. Every key goes to the form while it is shown.
 *
 * It keeps the values and draws them; checking and running actions are its owner's job, via
 * `validate`, `onAction` and the setters.
 */
export class Form implements Component {
  private fields: FieldState[]
  private focus: string
  private touched = new Set<string>()
  private submitted = false
  private errors: Record<string, string> = {}
  private confirming = false
  private status: { text: string; tone: FormStatusTone } | undefined
  private top = 0
  private initial: string

  constructor(private opts: FormOptions) {
    const values = opts.values ?? {}
    this.fields = opts.fields.map((def) => this.makeField(def, values[def.id]))
    this.initial = JSON.stringify(this.values)
    this.focus = this.order()[0] ?? SUBMIT
  }

  /** Every field's value; an empty number is left out and one that does not parse stays text. */
  get values(): Record<string, FormInputValue> {
    const out: Record<string, FormInputValue> = {}
    for (const f of this.fields) {
      const v = this.valueOf(f)
      if (v !== undefined) out[f.def.id] = v
    }
    return out
  }

  /** Something differs from the starting values. */
  get dirty(): boolean {
    return JSON.stringify(this.values) !== this.initial
  }

  /** The focused field's id, or "submit"/"cancel" for the buttons. */
  get focused(): string {
    return this.focus === SUBMIT ? "submit" : this.focus === CANCEL ? "cancel" : this.focus
  }

  /** Waiting for the user to say whether to discard their changes. */
  get confirmingCancel(): boolean {
    return this.confirming
  }

  setValues(values: Record<string, FormInputValue>): void {
    for (const [id, v] of Object.entries(values)) {
      const f = this.field(id)
      if (!f) continue
      if (f.input) f.input.value = String(v)
      else if (f.editor) f.editor.setText(String(v))
      else if (f.def.type === "multiselect" && Array.isArray(v)) f.value = [...v]
      else if (f.def.type === "checkbox" && typeof v === "boolean") f.value = v
      else if (f.def.type === "select" && typeof v === "string") f.value = v
    }
    this.refreshErrors()
  }

  /** New options for a select or checklist; checked values that are no options stay as extra rows. */
  setOptions(id: string, options: FormChoice[]): void {
    const f = this.field(id)
    if (!f) return
    f.options = options
    if (f.def.type === "select" && !options.some((o) => o.value === f.value))
      f.value = options[0]?.value ?? ""
    f.highlight = 0
    f.top = 0
    this.refreshErrors()
  }

  setActionState(id: string, state: ActionState): void {
    const f = this.field(id)
    if (f) f.action = state
  }

  /** Problems reported from outside, e.g. by the host refusing the values; shown at once. */
  setErrors(errors: Record<string, string>): void {
    this.submitted = true
    this.errors = errors
    const first = this.order().find((id) => errors[id])
    if (first) this.focus = first
  }

  /** A line above the buttons; undefined clears it. */
  setStatus(text: string | undefined, tone: FormStatusTone = "info"): void {
    this.status = text === undefined ? undefined : { text, tone }
  }

  handleInput(e: InputEvent): boolean {
    if (this.confirming) {
      if (matchesKey(e, "y")) {
        this.confirming = false
        this.opts.onCancel()
      } else if (
        matchesKey(e, "n") ||
        matchesKey(e, "escape") ||
        matchesKey(e, "enter") ||
        matchesKey(e, "c", { ctrl: true })
      ) {
        this.confirming = false
      }
      return true
    }
    if (matchesKey(e, "s", { ctrl: true })) {
      this.submit()
      return true
    }
    if (matchesKey(e, "c", { ctrl: true })) {
      this.requestCancel()
      return true
    }
    const f = this.field(this.focus)
    if (f && this.fieldInput(f, e)) {
      this.refreshErrors()
      return true
    }
    if (matchesKey(e, "tab", { shift: false }) || matchesKey(e, "down")) this.move(1)
    else if (matchesKey(e, "tab", { shift: true }) || matchesKey(e, "up")) this.move(-1)
    else if (matchesKey(e, "pagedown")) this.move(5)
    else if (matchesKey(e, "pageup")) this.move(-5)
    else if (matchesKey(e, "enter") || matchesKey(e, "space")) {
      if (this.focus === SUBMIT) this.submit()
      else if (this.focus === CANCEL) this.requestCancel()
      else if (matchesKey(e, "enter")) this.move(1)
    } else if (matchesKey(e, "escape")) this.requestCancel()
    // Every other key is swallowed, so nothing reaches what is behind the form.
    return true
  }

  render(width: number, ctx: RenderContext): string[] {
    const { theme } = ctx
    const values = this.values
    const order = this.order(values)
    if (!order.includes(this.focus)) {
      // The focused field was hidden by another's change: focus the next one that shows.
      const from = this.fields.findIndex((f) => f.def.id === this.focus)
      this.focus = this.fields.slice(from + 1).find((f) => order.includes(f.def.id))?.def.id ?? SUBMIT
    }
    let header = [bold(theme.accent(truncateToWidth(this.opts.title, width, "…")))]
    const description = this.opts.description
      ? wrapText(this.opts.description, width).map((l) => theme.muted(l))
      : []
    const rule = theme.border((ctx.glyphs?.rule ?? "─").repeat(width))
    const footer = this.footer(width, ctx)
    // Too few rows for everything: drop the description, then the rules; keep a body row.
    if (1 + description.length + 1 + footer.length + 2 <= ctx.rows) header = [...header, ...description, rule]
    else if (1 + footer.length + 3 <= ctx.rows) header = [...header, rule]
    const bodyRows = Math.max(1, ctx.rows - header.length - footer.length)
    const { lines, spans } = this.body(width, ctx, values)
    const span = spans.get(this.focus)
    if (span && span.end - span.start <= bodyRows) {
      if (span.start < this.top) this.top = span.start
      else if (span.end > this.top + bodyRows) this.top = span.end - bodyRows
    } else if (span) {
      // Taller than the body: from its start if its active line (the caret, the highlighted
      // row) still shows, else scrolled just far enough to show that line.
      this.top = Math.max(span.active - bodyRows + 1, Math.min(span.start, span.active))
    }
    this.top = Math.max(0, Math.min(this.top, lines.length - bodyRows))
    const body = lines.slice(this.top, this.top + bodyRows)
    while (body.length < bodyRows) body.push("")
    const more = [this.top > 0 ? "↑" : "", this.top + bodyRows < lines.length ? "↓" : ""].filter(Boolean)
    if (more.length) {
      // The scroll hint takes the end of the last body row.
      const hint = theme.muted(` ${more.join("")} more`)
      const room = width - visibleWidth(hint)
      body[body.length - 1] = truncateToWidth(body[body.length - 1]!, Math.max(0, room)) + hint
    }
    return [...header, ...body, ...footer].slice(0, Math.max(1, ctx.rows))
  }

  private makeField(def: FormFieldView, initial: FormInputValue | undefined): FieldState {
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

  private valueOf(f: FieldState): FormInputValue | undefined {
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

  private field(id: string): FieldState | undefined {
    return this.fields.find((f) => f.def.id === id)
  }

  private shown(values = this.values): FieldState[] {
    const visible = this.opts.visible
    return this.fields.filter((f) => !visible || visible(f.def, values))
  }

  /** Focus order: the fields that show, then the buttons. */
  private order(values = this.values): string[] {
    return [...this.shown(values).map((f) => f.def.id), SUBMIT, CANCEL]
  }

  private move(step: number): void {
    const order = this.order()
    const i = Math.max(0, order.indexOf(this.focus))
    const next = order[Math.max(0, Math.min(order.length - 1, i + step))]!
    this.leave()
    this.focus = next
  }

  /** The focused field loses focus: it counts as visited, and a select's list closes. */
  private leave(): void {
    const f = this.field(this.focus)
    if (!f) return
    f.open = false
    f.filter = ""
    this.touched.add(f.def.id)
    this.refreshErrors()
  }

  private refreshErrors(): void {
    this.errors = this.opts.validate?.(this.values) ?? {}
  }

  private shownError(id: string): string | undefined {
    return this.submitted || this.touched.has(id) ? this.errors[id] : undefined
  }

  private submit(): void {
    this.leave()
    this.submitted = true
    this.refreshErrors()
    const bad = this.order().filter((id) => this.errors[id])
    if (bad.length) {
      this.focus = bad[0]!
      this.setStatus(`Fix ${bad.length === 1 ? "1 field" : `${bad.length} fields`} before saving.`, "error")
      return
    }
    this.setStatus(undefined)
    this.opts.onSubmit(this.values)
  }

  private requestCancel(): void {
    if (this.dirty) this.confirming = true
    else this.opts.onCancel()
  }

  /** The focused field's own keys; false leaves the key to the form. */
  private fieldInput(f: FieldState, e: InputEvent): boolean {
    switch (f.def.type) {
      case "text":
      case "secret":
      case "number":
        return f.input!.handleInput(e)
      case "textarea":
        // Enter moves on like in the other fields; the newline key breaks the line.
        if (isSubmitKey(e) || matchesKey(e, "tab") || matchesKey(e, "escape")) return false
        return f.editor!.handleInput(e)
      case "select":
        return this.selectInput(f, e)
      case "multiselect":
        return this.checklistInput(f, e)
      case "checkbox":
        if (matchesKey(e, "space") || matchesKey(e, "enter")) {
          f.value = !f.value
          return true
        }
        return false
      case "action":
        if (f.action?.running && matchesKey(e, "escape")) {
          this.opts.onActionCancel?.(f.def.id)
          return true
        }
        if (matchesKey(e, "enter") || matchesKey(e, "space")) {
          if (!f.action?.running) this.opts.onAction?.(f.def.id, this.values)
          return true
        }
        return false
    }
  }

  private selectInput(f: FieldState, e: InputEvent): boolean {
    const list = this.filtered(f)
    if (!f.open) {
      if (matchesKey(e, "enter") || matchesKey(e, "space")) {
        f.open = true
        f.filter = ""
        f.highlight = Math.max(
          0,
          f.options.findIndex((o) => o.value === f.value),
        )
        return true
      }
      const step = matchesKey(e, "right") ? 1 : matchesKey(e, "left") ? -1 : 0
      if (!step || !f.options.length) return false
      const i = f.options.findIndex((o) => o.value === f.value)
      f.value = f.options[(i + step + f.options.length) % f.options.length]!.value
      return true
    }
    if (matchesKey(e, "escape")) {
      f.open = false
      f.filter = ""
      return true
    }
    if (matchesKey(e, "up")) f.highlight = Math.max(0, f.highlight - 1)
    else if (matchesKey(e, "down")) f.highlight = Math.min(Math.max(0, list.length - 1), f.highlight + 1)
    else if (matchesKey(e, "enter")) {
      const o = list[f.highlight]
      if (o) f.value = o.value
      f.open = false
      f.filter = ""
    } else if (matchesKey(e, "tab", { shift: false }) || matchesKey(e, "tab", { shift: true })) {
      f.open = false
      f.filter = ""
      return false
    } else if (!this.filterInput(f, e)) return true
    return true
  }

  private checklistInput(f: FieldState, e: InputEvent): boolean {
    const rows = this.checklistRows(f)
    const checked = f.value as string[]
    const toggle = (v: string) => {
      f.value = checked.includes(v) ? checked.filter((x) => x !== v) : [...checked, v]
    }
    if (matchesKey(e, "up")) {
      if (f.highlight <= 0) return false
      f.highlight--
      return true
    }
    if (matchesKey(e, "down")) {
      if (f.highlight >= rows.length - 1) return false
      f.highlight++
      return true
    }
    if (matchesKey(e, "space")) {
      const row = rows[f.highlight]
      if (row) toggle(row.value)
      return true
    }
    if (matchesKey(e, "enter")) {
      const typed = f.filter.trim()
      if (typed && f.def.allowCustom && !rows.some((r) => r.value === typed)) {
        if (!checked.includes(typed)) f.value = [...checked, typed]
        f.filter = ""
        f.highlight = Math.max(
          0,
          this.checklistRows(f).findIndex((r) => r.value === typed),
        )
        return true
      }
      const row = rows[f.highlight]
      if (!row) return false
      toggle(row.value)
      return true
    }
    if (matchesKey(e, "a", { ctrl: true })) {
      const all = rows.every((r) => checked.includes(r.value))
      const values = new Set(rows.map((r) => r.value))
      f.value = all ? checked.filter((v) => !values.has(v)) : [...new Set([...checked, ...values])]
      return true
    }
    if (matchesKey(e, "escape") && f.filter) {
      f.filter = ""
      f.highlight = 0
      return true
    }
    if (e.type === "paste" && f.def.allowCustom && /[\s,]/.test(e.text.trim())) {
      // A pasted list of values adds them all.
      const add = e.text.split(/[\s,]+/).filter(Boolean)
      f.value = [...new Set([...checked, ...add])]
      return true
    }
    return this.filterInput(f, e)
  }

  /** Typing into a list's filter; false for keys that are not typing. */
  private filterInput(f: FieldState, e: InputEvent): boolean {
    if (e.type === "focus" || e.type === "mouse") return false
    if (e.type === "paste") f.filter += e.text.replace(/\s+/g, "").replace(CONTROL, "")
    else if (e.name === "backspace" && !e.ctrl && !e.alt) {
      if (!f.filter) return false
      f.filter = graphemes(f.filter).slice(0, -1).join("")
    } else if (e.text && !e.ctrl && !e.alt && e.name !== "space") f.filter += e.text
    else return false
    f.highlight = 0
    f.top = 0
    return true
  }

  private filtered(f: FieldState): FormChoice[] {
    const q = f.filter.toLowerCase()
    if (!q) return f.options
    return f.options.filter((o) => `${o.value} ${o.label ?? ""}`.toLowerCase().includes(q))
  }

  /** A checklist's rows: its options, then checked values that are no options, filtered. */
  private checklistRows(f: FieldState): FormChoice[] {
    const extra = (f.value as string[])
      .filter((v) => !f.options.some((o) => o.value === v))
      .map((value) => ({ value }))
    const all: FormChoice[] = [...f.options, ...extra]
    const q = f.filter.toLowerCase()
    return q ? all.filter((o) => `${o.value} ${o.label ?? ""}`.toLowerCase().includes(q)) : all
  }

  private body(
    width: number,
    ctx: RenderContext,
    values: Record<string, FormInputValue>,
  ): { lines: string[]; spans: Map<string, Span> } {
    const { theme } = ctx
    const lines: string[] = []
    const spans = new Map<string, Span>()
    const inner = Math.max(4, width - INDENT.length)
    let section: string | undefined
    for (const f of this.shown(values)) {
      const start = lines.length
      if (f.def.section !== section) {
        section = f.def.section
        if (section) {
          if (lines.length) lines.push("")
          lines.push(bold(truncateToWidth(section, width, "…")))
          const help = this.opts.sections?.find((s) => s.title === section)?.help
          if (help) for (const l of wrapText(help, width)) lines.push(theme.muted(l))
        }
      }
      // The section heading scrolls into view with its first field.
      const at = lines.length
      const { lines: own, active } = this.fieldLines(f, width, inner, ctx)
      lines.push(...own)
      spans.set(f.def.id, { start, end: lines.length, active: at + active })
    }
    return { lines, spans }
  }

  /** A field's lines, and which of them has the caret or the highlight. */
  private fieldLines(
    f: FieldState,
    width: number,
    inner: number,
    ctx: RenderContext,
  ): { lines: string[]; active: number } {
    const { theme } = ctx
    let active = 0
    const focused = this.focus === f.def.id
    const mark = focused ? theme.accent(POINTER) : " "
    const name = focused ? theme.accent(f.def.label) : f.def.label
    const star = f.def.required ? theme.muted(" *") : ""
    const out: string[] = []
    const label = (prefix = "") => truncateToWidth(`${mark} ${prefix}${name}${star}`, width, "…")
    switch (f.def.type) {
      case "text":
      case "secret":
      case "number": {
        out.push(label())
        const empty = !f.input!.value
        const placeholder = f.def.placeholder ?? (focused ? "" : "(empty)")
        let line = f.input!.render(inner, theme, { focused, placeholder })
        if (f.def.type === "secret" && !empty)
          line += theme.muted(` ${graphemes(f.input!.value).length} chars`)
        active = out.length
        out.push(INDENT + line)
        break
      }
      case "textarea": {
        out.push(label())
        const editor = f.editor!
        editor.focused = focused
        const rows = editor.render(inner, ctx)
        active =
          out.length +
          Math.max(
            0,
            rows.findIndex((l) => l.includes(CURSOR_MARKER)),
          )
        for (const l of rows) out.push(INDENT + l)
        break
      }
      case "select": {
        out.push(label())
        const chosen = f.options.find((o) => o.value === f.value)
        const text = chosen ? (chosen.label ?? chosen.value) : String(f.value || "(none)")
        const desc = chosen?.description ? theme.muted(` · ${chosen.description}`) : ""
        const arrows = focused ? theme.muted(f.open ? " ▴" : " ◂▸") : ""
        out.push(
          truncateToWidth(`${INDENT}${focused ? theme.accent(text) : text}${arrows}${desc}`, width, "…"),
        )
        if (f.open) {
          if (f.filter)
            out.push(
              truncateToWidth(`${INDENT}${theme.muted("filter ›")} ${f.filter}${CURSOR_MARKER}`, width),
            )
          const list = this.filtered(f)
          if (!list.length) out.push(INDENT + theme.muted("no match"))
          const rows = this.listLines(f, list, width, theme, (o) => o.value === f.value)
          active = out.length + Math.max(0, f.highlight - f.top)
          out.push(...rows)
        }
        break
      }
      case "multiselect": {
        out.push(label())
        const checked = f.value as string[]
        if (!focused) {
          const names = checked.join(", ")
          out.push(
            checked.length
              ? truncateToWidth(`${INDENT}${checked.length} selected: ${names}`, width, "…")
              : INDENT + theme.muted(f.options.length ? "none selected" : "(no options yet)"),
          )
          break
        }
        const rows = this.checklistRows(f)
        const typed = f.filter.trim()
        if (f.filter) {
          const adds = f.def.allowCustom && typed && !rows.some((r) => r.value === typed)
          out.push(
            truncateToWidth(
              `${INDENT}${theme.muted("filter ›")} ${f.filter}${CURSOR_MARKER}${adds ? theme.muted(`  ${keyLabel({ name: "enter" })} adds it`) : ""}`,
              width,
            ),
          )
        }
        if (!rows.length) {
          out.push(INDENT + theme.muted(f.filter ? "no match" : "(no options yet)"))
        } else {
          const list = this.listLines(f, rows, width, theme, (o) => checked.includes(o.value), true)
          active = out.length + (f.highlight - f.top)
          out.push(...list)
        }
        out.push(INDENT + theme.muted(`${checked.length} selected`))
        break
      }
      case "checkbox":
        out.push(label(`${f.value ? "[x]" : "[ ]"} `))
        break
      case "action": {
        const a = f.action ?? { running: false }
        out.push(truncateToWidth(`${mark} ${button(f.def.label, focused, ctx)}`, width, "…"))
        if (a.running) {
          out.push(
            truncateToWidth(
              INDENT + theme.muted(`… ${a.text ?? "working"} · ${keyLabel({ name: "escape" })} stops it`),
              width,
              "…",
            ),
          )
        } else if (a.text) {
          const style = toneStyle(theme, a.tone)
          for (const l of wrapText(a.text, inner)) out.push(INDENT + style(l))
        }
        break
      }
    }
    if (f.def.help) for (const l of wrapText(f.def.help, inner)) out.push(INDENT + theme.muted(l))
    const error = this.shownError(f.def.id)
    if (error) for (const l of wrapText(`✗ ${error}`, inner)) out.push(INDENT + theme.error(l))
    return { lines: out, active }
  }

  /** Rows of a select's list or a checklist, scrolled to keep the highlight in view. */
  private listLines(
    f: FieldState,
    rows: FormChoice[],
    width: number,
    theme: Theme,
    on: (o: FormChoice) => boolean,
    boxes = false,
  ): string[] {
    f.highlight = Math.max(0, Math.min(f.highlight, rows.length - 1))
    if (f.highlight < f.top) f.top = f.highlight
    if (f.highlight >= f.top + LIST_ROWS) f.top = f.highlight - LIST_ROWS + 1
    f.top = Math.max(0, Math.min(f.top, rows.length - LIST_ROWS))
    const out = rows.slice(f.top, f.top + LIST_ROWS).map((o, j) => {
      const i = f.top + j
      const hl = i === f.highlight
      const box = boxes ? `${on(o) ? "[x]" : "[ ]"} ` : on(o) ? "● " : "  "
      const text = `${box}${o.label ?? o.value}`
      const desc = o.description ? theme.muted(`  ${o.description}`) : ""
      return truncateToWidth(
        `${INDENT}${hl ? theme.accent(`${POINTER} ${text}`) : `  ${text}`}${desc}`,
        width,
        "…",
      )
    })
    if (rows.length > LIST_ROWS) out.push(INDENT + theme.muted(`  ${f.highlight + 1}/${rows.length}`))
    return out
  }

  private footer(width: number, ctx: RenderContext): string[] {
    const { theme } = ctx
    const out = [theme.border((ctx.glyphs?.rule ?? "─").repeat(width))]
    for (const n of this.opts.notice?.() ?? []) out.push(theme.warning(truncateToWidth(n, width, "…")))
    if (this.confirming) {
      out.push(theme.warning(truncateToWidth("Discard your changes? y discard · n keep editing", width, "…")))
      return out
    }
    if (this.status)
      out.push(toneStyle(theme, this.status.tone)(truncateToWidth(this.status.text, width, "…")))
    const save = button(this.opts.submitLabel ?? "Save", this.focus === SUBMIT, ctx)
    const cancel = button("Cancel", this.focus === CANCEL, ctx)
    const mark = (on: boolean) => (on ? theme.accent(POINTER) : " ")
    out.push(
      truncateToWidth(
        `${mark(this.focus === SUBMIT)} ${save}  ${mark(this.focus === CANCEL)} ${cancel}`,
        width,
      ),
    )
    out.push(theme.muted(truncateToWidth(this.hint(), width, "…")))
    return out
  }

  private hint(): string {
    const f = this.field(this.focus)
    const enter = keyLabel({ name: "enter" })
    const esc = keyLabel({ name: "escape" })
    const tab = keyLabel({ name: "tab" })
    const space = keyLabel({ name: "space" })
    const save = keyLabel({ name: "s", ctrl: true })
    const common = `${tab}/↑↓ move · ${save} save · ${esc} cancel`
    if (!f) return `${enter} press · ${common}`
    switch (f.def.type) {
      case "select":
        return f.open
          ? `↑↓ pick · type to filter · ${enter} choose · ${esc} close`
          : `${enter} list · ←→ change · ${common}`
      case "multiselect":
        return `${space} toggle · type to filter${f.def.allowCustom ? " or add" : ""} · ${keyLabel({ name: "a", ctrl: true })} all · ${common}`
      case "checkbox":
        return `${space} toggle · ${common}`
      case "textarea":
        return `${keyLabel({ name: "enter", shift: true })} newline · ${enter} next · ${common}`
      case "action":
        return f.action?.running ? `${esc} stop · ${tab}/↑↓ move · ${save} save` : `${enter} run · ${common}`
      default:
        return `${enter} next · ${common}`
    }
  }
}

function button(label: string, focused: boolean, ctx: RenderContext): string {
  const text = `[ ${label} ]`
  return focused ? ctx.theme.accent(ctx.color ? inverse(text) : text) : text
}

function toneStyle(theme: Theme, tone: FormStatusTone | undefined) {
  switch (tone) {
    case "success":
      return theme.success
    case "warning":
      return theme.warning
    case "error":
      return theme.error
    default:
      return theme.text
  }
}
