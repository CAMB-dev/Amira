import { type Component, CURSOR_MARKER, type RenderContext } from "../component.ts"
import { chromeGlyphs, defaultGlyphs } from "../glyphs.ts"
import { type InputEvent, isSubmitKey, key, type MouseInput, matchesKey } from "../keys.ts"
import { bold } from "../style.ts"
import { truncateToWidth, visibleWidth, wrapText } from "../width.ts"
import { bulkField, bulkId, renderFormBody, sectionId, summaryId } from "./form-body.ts"
import { drawFormCard } from "./form-card.ts"
import type { FormFieldState as FieldState } from "./form-field.ts"
import { CANCEL, PREVIEW, renderFormFooter, SUBMIT } from "./form-footer.ts"
import { type FormHit, FormMouse } from "./form-mouse.ts"
import {
  filteredFormChoices,
  filterFormInput,
  formChecklistRows,
  formFieldValue,
  makeFormField,
  setFormFilter,
} from "./form-state.ts"

export { LineInput, type LineInputOptions } from "./line-input.ts"

/** A value of one form field. */
export type FormInputValue = string | number | boolean | string[]

export interface FormChoice {
  value: string
  group?: string
  label?: string
  description?: string
  /** Right-aligned multiselect note, or independent trailing columns (rightmost dropped first). */
  detail?: string | string[]
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
  /** Actions placed with Save and Cancel instead of in the body. */
  placement?: "footer"
  /** Short action label, e.g. in the footer. */
  buttonLabel?: string
  /** Explicit test action shortcut; never inferred from an id or label. */
  shortcut?: "ctrl+t"
  /** Show this action and status inside the named multiselect's card row. */
  inline?: string
}

export type FormStatusTone = "info" | "success" | "warning" | "error"

export interface FormOptions {
  title: string
  /** Centred bordered grid on roomy terminals; plain layout on small terminals. */
  layout?: "card"
  description?: string
  fields: FormFieldView[]
  sections?: { title: string; help?: string; collapsed?: boolean }[]
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
  /**
   * Ends a notice or status cut to the width. Hosts whose glyph set draws a one-cell `more`
   * pass their own marker, so a cut ends in a complete ellipsis; `undefined` keeps the render
   * context's own marker.
   */
  more?: () => string | undefined
  /** Computed display lines supplied by the host backend. */
  preview?: () => string[]
  /** Card-only expandable summaries; grouped fields retain their values. */
  summaries?: { id: string; fields: string[]; label: string; text: string }[]
}

interface ActionState {
  running: boolean
  text?: string
  tone?: FormStatusTone
}

const INDENT = "  "
const separator = (ctx: RenderContext) => ctx.glyphs?.separator ?? defaultGlyphs.separator ?? "·"

/**
 * A full-screen form, optionally presented as a centred card: a title, a scrolling body of
 * fields and a footer with actions, Save and Cancel. Tab/Shift+Tab or ↓/↑ move between fields; typing edits the focused text
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
  private hasPreview = false
  private previewTop = 0
  private previewLength = 0
  private previewRows = 1
  private previewExpanded = false
  private previewActive = false
  private expandedSummaries = new Set<string>()
  private collapsed = new Set<string>()
  private initial: string
  private mouse = new FormMouse()
  private mouseScrolling = false

  constructor(private opts: FormOptions) {
    for (const section of opts.sections ?? []) if (section.collapsed) this.collapsed.add(section.title)
    const values = opts.values ?? {}
    this.fields = opts.fields.map((def) => makeFormField(def, values[def.id]))
    this.initial = JSON.stringify(this.values)
    this.focus = this.order()[0] ?? SUBMIT
  }

  /** Whether this form opts into the card presentation (small terminals still render plain). */
  get cardLayout(): boolean {
    return this.opts.layout === "card"
  }

  /** Every field's value; an empty number is left out and one that does not parse stays text. */
  get values(): Record<string, FormInputValue> {
    const out: Record<string, FormInputValue> = {}
    for (const f of this.fields) {
      const v = formFieldValue(f)
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
    return this.focus === SUBMIT
      ? "submit"
      : this.focus === CANCEL
        ? "cancel"
        : this.focus === PREVIEW
          ? "preview"
          : this.focus
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

  /** Replaces card summaries; new IDs start folded, while text updates preserve editing. */
  setSummaries(summaries: NonNullable<FormOptions["summaries"]>): void {
    for (const id of this.expandedSummaries)
      if (!summaries.some((summary) => summary.id === id)) this.expandedSummaries.delete(id)
    this.opts.summaries = summaries
  }

  setActionState(id: string, state: ActionState): void {
    const f = this.field(id)
    if (f) f.action = state
  }

  /** Problems reported from outside, e.g. by the host refusing the values; shown at once. */
  setErrors(errors: Record<string, string>): void {
    this.submitted = true
    this.errors = errors
    this.expandErrors()
    const first = this.order().find((id) => errors[id])
    if (first) this.focus = first
  }

  /** A line above the buttons; undefined clears it. */
  setStatus(text: string | undefined, tone: FormStatusTone = "info"): void {
    this.status = text === undefined ? undefined : { text, tone }
  }

  handleInput(e: InputEvent): boolean {
    if (e.type === "mouse") return this.mouseInput(e)
    if (e.type === "focus" && !e.focused) this.mouse.reset()
    this.mouseScrolling = false
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
    if (this.cardLayout && (matchesKey(e, "pageup") || matchesKey(e, "pagedown"))) {
      this.top += (matchesKey(e, "pageup") ? -1 : 1) * Math.max(1, this.mouse.viewport.rows - 1)
      this.top = Math.max(0, Math.min(this.top, this.mouse.viewport.length - this.mouse.viewport.rows))
      this.mouseScrolling = true
      return true
    }
    if (this.cardLayout && matchesKey(e, "p", { ctrl: true }) && this.hasPreview) {
      this.previewExpanded = !this.previewExpanded
      return true
    }
    if (this.cardLayout && this.previewActive && (matchesKey(e, "enter") || matchesKey(e, "space"))) {
      this.previewExpanded = !this.previewExpanded
      return true
    }
    this.previewActive = false
    if (this.cardLayout && matchesKey(e, "t", { ctrl: true })) {
      const action = this.shown().find((f) => f.def.type === "action" && f.def.shortcut === "ctrl+t")
      if (action && !action.action?.running) this.opts.onAction?.(action.def.id, this.values)
      return true
    }
    const summary = this.opts.summaries?.find((item) => summaryId(item.id) === this.focus)
    if (summary && (matchesKey(e, "enter") || matchesKey(e, "space"))) {
      if (this.expandedSummaries.has(summary.id)) this.expandedSummaries.delete(summary.id)
      else this.expandedSummaries.add(summary.id)
      return true
    }
    if (this.cardLayout && (matchesKey(e, "left") || matchesKey(e, "right"))) {
      const bulk = bulkField(this.focus)
      const target = bulk?.id ?? this.field(this.focus)?.def.inline
      const row = target
        ? [bulkId(target, "all"), bulkId(target, "none"), ...this.inlineActions(target).map((f) => f.def.id)]
        : [...this.footerActions().map((f) => f.def.id), SUBMIT, CANCEL]
      const at = row.indexOf(this.focus)
      if (at >= 0) {
        this.focus = row[Math.max(0, Math.min(row.length - 1, at + (matchesKey(e, "left") ? -1 : 1)))]!
        return true
      }
    }
    const bulk = this.cardLayout ? bulkField(this.focus) : undefined
    if (bulk && (matchesKey(e, "enter") || matchesKey(e, "space"))) {
      const field = this.field(bulk.id)
      if (field) this.bulkSelect(field, bulk.action)
      this.refreshErrors()
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
    const section = this.opts.sections?.find(
      (s) => sectionId(s.title) === this.focus && s.collapsed !== undefined,
    )
    if (
      section &&
      (matchesKey(e, "enter") || matchesKey(e, "space") || matchesKey(e, "left") || matchesKey(e, "right"))
    ) {
      const close = matchesKey(e, "left") || (!matchesKey(e, "right") && !this.collapsed.has(section.title))
      if (close) this.collapsed.add(section.title)
      else this.collapsed.delete(section.title)
      return true
    }
    if (
      this.focus === PREVIEW &&
      (["up", "down", "pageup", "pagedown", "home", "end"] as const).some((name) => matchesKey(e, name))
    ) {
      const step = matchesKey(e, "pageup") || matchesKey(e, "pagedown") ? this.previewRows : 1
      const next = matchesKey(e, "home")
        ? 0
        : matchesKey(e, "end")
          ? this.previewLength - 1
          : this.previewTop + (matchesKey(e, "up") || matchesKey(e, "pageup") ? -step : step)
      this.previewTop = Math.max(0, Math.min(Math.max(0, this.previewLength - 1), next))
      return true
    }
    const f = this.field(this.focus)
    if (
      f &&
      (!bulk || matchesKey(e, "a", { ctrl: true }) || matchesKey(e, "escape")) &&
      this.fieldInput(f, e)
    ) {
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
      else if (matchesKey(e, "enter") && !this.cardLayout) this.move(1)
    } else if (matchesKey(e, "escape")) this.requestCancel()
    // Every other key is swallowed, so nothing reaches what is behind the form.
    return true
  }

  private mouseInput(e: MouseInput): boolean {
    if (this.confirming) {
      const hit = this.mouse.handle(e)?.target
      if (hit?.kind === "confirm" && (hit.value === "n" || hit.value === "y"))
        this.handleInput(key(hit.value))
      return true
    }
    if (e.action === "wheel") {
      if (e.button !== "up" && e.button !== "down") return true
      const step = e.button === "up" ? -1 : 1
      const target = this.mouse.at(e)
      if (target?.focus === PREVIEW) {
        this.previewTop = Math.max(0, Math.min(this.previewLength - 1, this.previewTop + step * 3))
        if (e.x < this.mouse.viewport.width) {
          this.top = Math.max(
            0,
            Math.min(this.mouse.viewport.length - this.mouse.viewport.rows, this.top + step * 3),
          )
          this.mouseScrolling = true
        }
      } else if (target?.kind === "option" || target?.kind === "list") {
        const f = this.field(target.focus)
        if (f) {
          const rows = f.def.type === "select" ? filteredFormChoices(f) : formChecklistRows(f)
          f.highlight = Math.max(0, Math.min(rows.length - 1, f.highlight + step))
          this.mouseScrolling = false
        }
      } else if (
        e.x >= (this.mouse.viewport.x ?? 0) &&
        e.x < this.mouse.viewport.width &&
        e.y >= this.mouse.viewport.y &&
        e.y < this.mouse.viewport.y + this.mouse.viewport.rows
      ) {
        this.top = Math.max(
          0,
          Math.min(this.mouse.viewport.length - this.mouse.viewport.rows, this.top + step * 3),
        )
        this.mouseScrolling = true
      }
      return true
    }
    const click = this.mouse.handle(e)
    if (!click) return true
    const { target } = click
    this.mouseScrolling = false
    if (this.cardLayout && target.focus === PREVIEW) {
      this.previewExpanded = !this.previewExpanded
      this.previewActive = true
      return true
    }
    this.previewActive = false
    if (this.focus !== target.focus) {
      this.leave(target.focus)
      this.focus = target.focus
    }
    const f = this.field(target.focus)
    if (target.kind === "input") f?.input?.placeCursor(click.x)
    else if (target.kind === "editor") f?.editor?.placeCursor(click.x, click.y)
    else if (target.kind === "option" && f) {
      f.highlight = target.index ?? 0
      // Use the same selection/toggle path as the keyboard (including validation).
      this.handleInput(key(f.def.type === "select" ? "enter" : "space"))
    } else if (target.kind === "activate" || target.kind === "bulk") {
      if (f?.def.type === "select" && f.open) this.handleInput(key("escape"))
      else this.handleInput(key("enter"))
    }
    return true
  }

  render(width: number, ctx: RenderContext): string[] {
    const { theme } = ctx
    const chrome = chromeGlyphs(ctx.glyphs)
    const values = this.values
    const rawPreview = this.opts.preview?.() ?? []
    const preview = this.cardLayout ? rawPreview.flatMap((line) => line.split(/\r?\n/)) : rawPreview
    this.hasPreview = preview.length > 0
    const order = this.order(values)
    if (!order.includes(this.focus)) {
      // The focused field was hidden by another's change: focus the next one that shows.
      const from = this.fields.findIndex((f) => f.def.id === this.focus)
      this.focus = this.fields.slice(from + 1).find((f) => order.includes(f.def.id))?.def.id ?? SUBMIT
    }
    if (this.cardLayout && width >= 60 && ctx.rows >= 20) return this.renderCard(width, ctx, values, preview)
    const inner = Math.max(1, width - INDENT.length)
    let header = [
      truncateToWidth(
        INDENT + bold(theme.accent(truncateToWidth(this.opts.title, inner, chrome.more))),
        width,
      ),
    ]
    const description = this.opts.description
      ? wrapText(this.opts.description, inner).map((l) => truncateToWidth(INDENT + theme.muted(l), width))
      : []
    const rule = theme.border((ctx.glyphs?.rule ?? "─").repeat(width))
    const footerHits: FormHit[] = []
    const footer = this.footer(width, ctx, footerHits)
    // Too few rows for everything: drop the description, then the rules; keep a body row.
    if (1 + description.length + 1 + footer.length + 2 <= ctx.rows) header = [...header, ...description, rule]
    else if (1 + footer.length + 3 <= ctx.rows) header = [...header, rule]
    const bodyRows = Math.max(1, ctx.rows - header.length - footer.length)
    this.previewRows = Math.max(1, bodyRows - 2)
    const sideBySide = !this.cardLayout && width >= 110 && preview.length > 0
    const formWidth = sideBySide ? Math.floor(width * 0.58) : width
    const { lines, spans, hits } = this.body(formWidth, ctx, values, sideBySide ? [] : preview)
    const span = this.mouseScrolling ? undefined : spans.get(this.focus)
    if (span && !this.cardLayout && this.focus === PREVIEW && !sideBySide)
      this.top = span.start + this.previewTop
    else if (span && span.end - span.start <= bodyRows) {
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
    const bodyWidths = body.map(() => formWidth)
    const more = [
      this.top > 0 ? chrome.arrowUp : "",
      this.top + bodyRows < lines.length ? chrome.arrowDown : "",
    ].filter(Boolean)
    if (more.length) {
      // Use the last row without a caret: truncating a filter must not hide its cursor.
      const row = body.findLastIndex((line) => !line.includes(CURSOR_MARKER))
      if (row >= 0) {
        const hint = theme.muted(truncateToWidth(` ${more.join("")} more`, width))
        const room = width - visibleWidth(hint)
        body[row] = truncateToWidth(body[row]!, Math.max(0, room)) + hint
        bodyWidths[row] = Math.max(0, Math.min(formWidth, room))
      }
    }
    if (sideBySide) {
      const previewWidth = width - formWidth - 3
      const previewLines = preview.slice(0, -1).flatMap((line) => wrapText(line, previewWidth))
      this.previewLength = previewLines.length
      this.previewTop = Math.max(0, Math.min(this.previewTop, Math.max(0, previewLines.length - 1)))
      const keyLines = wrapText(preview.at(-1) ?? "", previewWidth)
      const room = Math.max(0, bodyRows - keyLines.length - 2)
      const start = Math.min(this.previewTop, Math.max(0, previewLines.length - room))
      const title =
        this.focus === PREVIEW
          ? theme.accent(bold(`Preview (${chrome.arrowUp}${chrome.arrowDown} scroll)`))
          : bold("Preview")
      const visible = [title, ...previewLines.slice(start, start + room)]
      if (previewLines.length > room)
        visible.push(
          theme.muted(
            `${start > 0 ? chrome.arrowUp : ""}${start + room < previewLines.length ? chrome.arrowDown : ""} Tab to Preview ${separator(ctx)} PgUp/PgDn scroll`,
          ),
        )
      else visible.push("")
      while (visible.length + keyLines.length < bodyRows) visible.push("")
      visible.push(...keyLines)
      for (let row = 0; row < body.length; row++) {
        const left = truncateToWidth(body[row] ?? "", formWidth)
        body[row] =
          `${left}${" ".repeat(Math.max(0, formWidth - visibleWidth(left)))} ${theme.border("|")} ${theme.muted(visible[row] ?? "")}`
      }
    }
    const output = [...header, ...body, ...footer].slice(0, Math.max(1, ctx.rows))
    this.mouse.render(width, output.length, hits, footerHits, {
      y: header.length,
      rows: bodyRows,
      width: formWidth,
      length: lines.length,
      top: this.top,
      bodyWidths,
      preview: sideBySide ? PREVIEW : undefined,
    })
    return output
  }

  private renderCard(
    width: number,
    ctx: RenderContext,
    values: Record<string, FormInputValue>,
    preview: string[],
  ): string[] {
    const cardWidth = Math.min(width - 8, 88)
    const inner = cardWidth - 2
    const footerHits: FormHit[] = []
    const footer = this.footer(inner, ctx, footerHits, 2)
    const { lines, spans, hits } = this.body(inner, ctx, values, preview, true)
    const height = Math.min(Math.max(1, lines.length) + footer.length + 2, ctx.rows - 4)
    const bodyRows = Math.max(1, height - footer.length - 2)
    this.previewRows = Math.max(1, bodyRows - 2)
    const span = this.mouseScrolling ? undefined : spans.get(this.focus)
    if (span && span.end - span.start <= bodyRows) {
      if (span.start < this.top) this.top = span.start
      else if (span.end > this.top + bodyRows) this.top = span.end - bodyRows
    } else if (span) {
      this.top = Math.max(span.active - bodyRows + 1, Math.min(span.start, span.active))
    }
    this.top = Math.max(0, Math.min(this.top, lines.length - bodyRows))
    const body = lines.slice(this.top, this.top + bodyRows)
    while (body.length < bodyRows) body.push("")
    const { output, left, y } = drawFormCard(
      width,
      ctx,
      this.opts.title,
      body,
      footer,
      this.top,
      lines.length,
    )
    const offset = (hit: FormHit): FormHit => ({ ...hit, x: hit.x + left + 1 })
    this.mouse.render(width, output.length, hits.map(offset), footerHits.map(offset), {
      x: left + 1,
      y: y + 1,
      rows: bodyRows,
      width: left + cardWidth - 1,
      length: lines.length,
      top: this.top,
      bodyWidths: body.map(() => left + cardWidth - 1),
    })
    return output
  }

  private field(id: string): FieldState | undefined {
    return this.fields.find((f) => f.def.id === (bulkField(id)?.id ?? id))
  }

  private shown(values = this.values): FieldState[] {
    const visible = this.opts.visible
    return this.fields.filter((f) => !visible || visible(f.def, values))
  }

  /** Focus order: the fields that show, then the buttons. */
  private order(values = this.values): string[] {
    const order: string[] = []
    let previous: string | undefined
    for (const f of this.shown(values)) {
      if (
        f.def.type === "action" &&
        (f.def.placement === "footer" ||
          (this.cardLayout &&
            f.def.inline &&
            this.shown(values).some(
              (target) => target.def.id === f.def.inline && target.def.type === "multiselect",
            )))
      )
        continue
      const section = f.def.section
      if (
        section !== previous &&
        this.opts.sections?.some((s) => s.title === section && s.collapsed !== undefined)
      )
        order.push(sectionId(section!))
      previous = section
      if (section && this.collapsed.has(section)) continue
      const summary = this.cardLayout
        ? this.opts.summaries?.find((item) => item.fields.includes(f.def.id))
        : undefined
      if (summary && !order.includes(summaryId(summary.id))) order.push(summaryId(summary.id))
      if (summary && !this.expandedSummaries.has(summary.id)) continue
      order.push(f.def.id)
      if (this.cardLayout && f.def.type === "multiselect")
        order.push(
          bulkId(f.def.id, "all"),
          bulkId(f.def.id, "none"),
          ...this.inlineActions(f.def.id, values).map((action) => action.def.id),
        )
    }
    return [
      ...order,
      ...(this.hasPreview && !this.cardLayout ? [PREVIEW] : []),
      ...this.footerActions(values).map((f) => f.def.id),
      SUBMIT,
      CANCEL,
    ]
  }

  private inlineActions(id: string, values = this.values): FieldState[] {
    return this.shown(values).filter(
      (f) => f.def.type === "action" && f.def.inline === id && f.def.placement !== "footer",
    )
  }

  private footerActions(values = this.values): FieldState[] {
    return this.shown(values).filter((f) => f.def.type === "action" && f.def.placement === "footer")
  }

  private move(step: number): void {
    const order = this.order()
    const i = Math.max(0, order.indexOf(this.focus))
    const next =
      order[
        this.cardLayout && i === 0 && step === -1
          ? order.length - 1
          : Math.max(0, Math.min(order.length - 1, i + step))
      ]!
    this.leave(next)
    this.focus = next
  }

  /** The focused field loses focus: it counts as visited, and a select's list closes. */
  private leave(next?: string): void {
    const f = this.field(this.focus)
    if (!f || (next && (bulkField(next)?.id ?? next) === f.def.id)) return
    f.open = false
    if (f.def.type === "multiselect") setFormFilter(f, "")
    else f.filter = ""
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
    this.expandErrors()
    const bad = this.order().filter((id) => this.errors[id])
    if (bad.length) {
      this.focus = bad[0]!
      return
    }
    this.setStatus(undefined)
    this.opts.onSubmit(this.values)
  }

  private expandErrors(): void {
    for (const summary of this.opts.summaries ?? [])
      if (summary.fields.some((id) => this.errors[id])) this.expandedSummaries.add(summary.id)
    for (const f of this.fields)
      if (this.errors[f.def.id] && f.def.section) this.collapsed.delete(f.def.section)
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
        if (
          isSubmitKey(e) ||
          matchesKey(e, "tab") ||
          matchesKey(e, "escape") ||
          (this.cardLayout && (matchesKey(e, "up") || matchesKey(e, "down")))
        )
          return false
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
    const list = filteredFormChoices(f)
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
      if (this.cardLayout) return false
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
    if (this.cardLayout && (matchesKey(e, "up") || matchesKey(e, "down"))) return false
    if (matchesKey(e, "up") || (this.cardLayout && matchesKey(e, "left")))
      f.highlight = Math.max(0, f.highlight - 1)
    else if (matchesKey(e, "down") || (this.cardLayout && matchesKey(e, "right")))
      f.highlight = Math.min(Math.max(0, list.length - 1), f.highlight + 1)
    else if (matchesKey(e, "enter")) {
      const o = list[f.highlight]
      if (o) f.value = o.value
      f.open = false
      f.filter = ""
    } else if (matchesKey(e, "tab", { shift: false }) || matchesKey(e, "tab", { shift: true })) {
      f.open = false
      f.filter = ""
      return false
    } else if (!filterFormInput(f, e)) return true
    return true
  }

  private checklistInput(f: FieldState, e: InputEvent): boolean {
    const rows = formChecklistRows(f)
    const checked = f.value as string[]
    const toggle = (v: string) => {
      f.value = checked.includes(v) ? checked.filter((x) => x !== v) : [...checked, v]
    }
    if (this.cardLayout && (matchesKey(e, "up") || matchesKey(e, "down"))) return false
    if (this.cardLayout && (matchesKey(e, "left") || matchesKey(e, "right"))) {
      f.highlight = Math.max(0, Math.min(rows.length - 1, f.highlight + (matchesKey(e, "left") ? -1 : 1)))
      return true
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
          formChecklistRows(f).findIndex((r) => r.value === typed),
        )
        return true
      }
      const row = rows[f.highlight]
      if (!row) return false
      toggle(row.value)
      return true
    }
    if (matchesKey(e, "a", { ctrl: true }) || matchesKey(e, "x", { ctrl: true })) {
      const values = new Set(rows.map((r) => r.value))
      if (matchesKey(e, "x", { ctrl: true })) {
        f.value = [
          ...checked.filter((v) => !values.has(v)),
          ...[...values].filter((v) => !checked.includes(v)),
        ]
      } else {
        const all = rows.every((r) => checked.includes(r.value))
        f.value = all ? checked.filter((v) => !values.has(v)) : [...new Set([...checked, ...values])]
      }
      return true
    }
    if (matchesKey(e, "escape") && f.filter) {
      setFormFilter(f, "")
      return true
    }
    if (e.type === "paste" && f.def.allowCustom && /[\s,]/.test(e.text.trim())) {
      // A pasted list of values adds them all.
      const add = e.text.split(/[\s,]+/).filter(Boolean)
      f.value = [...new Set([...checked, ...add])]
      return true
    }
    return filterFormInput(f, e)
  }

  private bulkSelect(f: FieldState, action: "all" | "none"): void {
    const values = new Set(formChecklistRows(f).map((row) => row.value))
    const checked = f.value as string[]
    f.value =
      action === "all" ? [...new Set([...checked, ...values])] : checked.filter((value) => !values.has(value))
  }

  private body(
    width: number,
    ctx: RenderContext,
    values: Record<string, FormInputValue>,
    preview: string[],
    card = false,
  ) {
    const result = renderFormBody(width, ctx, preview, card, {
      shown: this.shown(values),
      opts: this.opts,
      cardLayout: this.cardLayout,
      collapsed: this.collapsed,
      expandedSummaries: this.expandedSummaries,
      focus: this.focus,
      shownError: (id) => this.shownError(id),
      previewExpanded: this.previewExpanded,
      previewTop: this.previewTop,
      previewLength: this.previewLength,
    })
    this.previewLength = result.previewLength
    return result
  }

  private footer(width: number, ctx: RenderContext, hits: FormHit[], hintInset = 0): string[] {
    const more = this.opts.more?.()
    return renderFormFooter(width, ctx, hits, {
      focus: this.focus,
      field: this.field(this.focus),
      confirming: this.confirming,
      bad: this.submitted ? this.order().filter((id) => this.errors[id]).length : 0,
      status: this.status,
      actions: this.footerActions(),
      submitLabel: this.opts.submitLabel,
      notice: this.opts.notice?.() ?? [],
      ...(more !== undefined ? { more } : {}),
      hintInset,
      card: this.cardLayout,
      preview: this.hasPreview,
    })
  }
}
