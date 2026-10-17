import { CURSOR_MARKER, type RenderContext } from "../component.ts"
import { chromeGlyphs, defaultGlyphs } from "../glyphs.ts"
import type { HitRect } from "../hit-test.ts"
import { keyLabel } from "../keys.ts"
import { bold, inverse, type Theme } from "../style.ts"
import { graphemes, truncateToWidth, visibleWidth, wrapText } from "../width.ts"
import type { Editor } from "./editor.ts"
import type { FormChoice, FormFieldView, FormInputValue, FormStatusTone } from "./form.ts"
import { renderFormList } from "./form-list.ts"
import type { LineInput } from "./line-input.ts"

export interface FormFieldState {
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
  action?: { running: boolean; text?: string; tone?: FormStatusTone }
}

const pointer = (ctx: RenderContext) => ctx.glyphs?.pointer ?? defaultGlyphs.pointer ?? "›"
const separator = (ctx: RenderContext) => ctx.glyphs?.separator ?? defaultGlyphs.separator ?? "·"

/** A rendered control target, relative to the field's first line. */
export interface FormFieldHit extends HitRect {
  kind: "focus" | "activate" | "input" | "list" | "option"
  index?: number
  value?: string
}

/** Draws controls without owning focus, validation, or state transitions. */
export function renderFormField(
  f: FormFieldState,
  width: number,
  column: number,
  stacked: boolean,
  ctx: RenderContext,
  focused: boolean,
  error: string | undefined,
  lists: { filtered: FormChoice[]; checklist: FormChoice[]; total: number },
  onHit?: (hit: FormFieldHit) => void,
  card = false,
): { lines: string[]; active: number } {
  const { theme } = ctx
  const chrome = chromeGlyphs(ctx.glyphs)
  const mark = focused ? theme.accent(ctx.color ? bold(pointer(ctx)) : pointer(ctx)) : " "
  const labelWidth = stacked ? Math.max(1, width - 2) : column - (card ? 5 : 4)
  const name = truncateToWidth(f.def.label + (f.def.required ? " *" : ""), labelWidth, chrome.more)
  const padding = " ".repeat(stacked ? 0 : Math.max(0, labelWidth - visibleWidth(name)))
  const label = card
    ? `${mark} ${focused ? theme.accent(name) : name}${padding} ${theme.border(ctx.glyphs?.tableColumn ?? defaultGlyphs.tableColumn)}`
    : `${mark} ${padding}${focused ? theme.accent(name) : name}`
  const indent = card
    ? `${" ".repeat(column - 2)}${theme.border(ctx.glyphs?.tableColumn ?? defaultGlyphs.tableColumn)} `
    : " ".repeat(column)
  const room = Math.max(1, width - column)
  const edge = room >= 3 ? 2 : 0
  const contentRoom = Math.max(1, room - edge)
  const out: string[] = []
  let active = 0
  const fill = ctx.color && !/^[\x20-\x7e]+$/.test(pointer(ctx)) ? theme.inputBg : undefined
  const control = (text: string) => {
    const clipped = truncateToWidth(text, contentRoom, chrome.more)
    const padded = clipped + " ".repeat(Math.max(0, contentRoom - visibleWidth(clipped)))
    const ink = focused ? theme.accent : (theme.inputFg ?? theme.text)
    return edge ? (fill ? fill(ink(` ${padded} `)) : focused ? ink(`[${padded}]`) : `[${padded}]`) : padded
  }
  const first = (text: string) => {
    if (stacked) {
      out.push(label)
      active = out.length
      out.push(indent + text)
    } else out.push(`${label}${card ? " " : "  "}${text}`)
    const kind = ["select", "checkbox", "action"].includes(f.def.type) ? "activate" : "focus"
    for (const [y, line] of out.entries())
      onHit?.({ kind, x: 0, y, width: Math.min(width, visibleWidth(line)), height: 1 })
  }
  const list = (rows: FormChoice[], on: (o: FormChoice) => boolean, boxes: boolean) => {
    const x = Math.max(0, card ? column : column - 2)
    const y = out.length
    const options: FormFieldHit[] = []
    const lines = renderFormList(
      f,
      rows,
      room + (card ? 0 : 2),
      ctx,
      on,
      boxes,
      "",
      (index, row, left, size) => {
        options.push({
          kind: "option",
          index,
          value: rows[index]?.value,
          x: x + left,
          y: y + row,
          width: size,
          height: 1,
        })
      },
    )
    onHit?.({ kind: "list", x, y, width: width - x, height: lines.length })
    for (const hit of options) onHit?.(hit)
    const prefix = card ? indent : " ".repeat(x)
    return lines.map((line) => prefix + line)
  }
  const hint = (text: string, style = theme.muted) => {
    for (const line of wrapText(text, contentRoom)) out.push(`${indent} ${style(line)}`)
  }
  switch (f.def.type) {
    case "text":
    case "secret":
    case "number": {
      const placeholder = f.def.placeholder ?? (focused ? "" : "(empty)")
      first(
        control(
          f.input!.render(
            contentRoom,
            fill ? { ...theme, muted: theme.surfaceMuted ?? theme.muted } : theme,
            { focused, placeholder, more: chrome.more },
          ),
        ),
      )
      onHit?.({
        kind: "input",
        x: (stacked ? column : visibleWidth(label) + (card ? 1 : 2)) + (edge ? 1 : 0),
        y: stacked ? 1 : 0,
        width: contentRoom,
        height: 1,
      })
      if (f.def.type === "secret" && f.input!.value) hint(`${graphemes(f.input!.value).length} chars`)
      break
    }
    case "textarea": {
      const editor = f.editor!
      editor.focused = focused
      const rows = editor.render(contentRoom, ctx)
      first(control(rows[0] ?? ""))
      for (const line of rows.slice(1)) {
        onHit?.({ kind: "focus", x: column, y: out.length, width: room, height: 1 })
        out.push(indent + control(line))
      }
      active = Math.max(
        0,
        out.findIndex((line) => line.includes(CURSOR_MARKER)),
      )
      break
    }
    case "select": {
      const chosen = f.options.find((o) => o.value === f.value)
      const text = chosen ? (chosen.label ?? chosen.value) : String(f.value || "(none)")
      const arrow = f.open ? chrome.selectOpen : chrome.disclosureOpen
      const available = Math.max(0, contentRoom - visibleWidth(arrow) - 1)
      const display = truncateToWidth(text, available, chrome.more)
      first(control(`${display + " ".repeat(Math.max(0, available - visibleWidth(display)))} ${arrow}`))
      if (chosen?.description && !f.open) hint(chosen.description)
      if (f.open) {
        if (f.filter) hint(`filter: ${f.filter}${CURSOR_MARKER}`)
        const filtered = lists.filtered
        if (!filtered.length) hint("no match")
        const rows = list(filtered, (o) => o.value === f.value, false)
        active = out.length + listActiveRow(rows)
        out.push(...rows)
      }
      break
    }
    case "multiselect": {
      const checked = f.value as string[]
      const total = lists.total
      const rows = lists.checklist
      first(
        theme.muted(
          `selected ${checked.length}/${total}${f.filter ? ` ${separator(ctx)} ${rows.length} shown` : ""}`,
        ),
      )
      if (!focused) {
        hint(
          checked.length
            ? `${checked.length} selected: ${checked.join(", ")}`
            : f.options.length
              ? "none selected"
              : "(no options yet)",
        )
        break
      }
      const adds = f.def.allowCustom && f.filter.trim() && !rows.some((r) => r.value === f.filter.trim())
      active = out.length
      const query = truncateToWidth(
        `${theme.muted("filter:")} ${f.filter}`,
        Math.max(0, contentRoom - 1),
        chrome.more,
      )
      onHit?.({ kind: "focus", x: column, y: out.length, width: room, height: 1 })
      out.push(indent + control(query + CURSOR_MARKER))
      if (adds) hint(`${keyLabel({ name: "enter" })} adds it`)
      if (!rows.length) hint(f.filter ? "no match" : "(no options yet)")
      else {
        const lines = list(rows, (o) => checked.includes(o.value), true)
        active = out.length + listActiveRow(lines)
        out.push(...lines)
      }
      break
    }
    case "checkbox":
      first(`${f.value ? "[x]" : "[ ]"}`)
      break
    case "action": {
      const action = f.action ?? { running: false }
      first(formButton(f.def.buttonLabel ?? f.def.label, focused, ctx))
      if (action.running)
        hint(
          `${chrome.more} ${action.text ?? "working"} ${separator(ctx)} ${keyLabel({ name: "escape" })} stops it`,
        )
      else if (action.text) hint(action.text, formToneStyle(theme, action.tone))
      break
    }
  }
  if (f.def.help) hint(f.def.help)
  if (error) hint(`${chrome.error} ${error}`, theme.error)
  return {
    lines: out.map((line) => {
      let clipped = truncateToWidth(line, width)
      if (line.includes(CURSOR_MARKER) && !clipped.includes(CURSOR_MARKER))
        clipped = truncateToWidth(line.replace(CURSOR_MARKER, ""), Math.max(0, width - 1)) + CURSOR_MARKER
      if (card && focused && ctx.color && theme.inputBg)
        return theme.inputBg(clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))))
      return clipped
    }),
    active,
  }

  function listActiveRow(rows: string[]): number {
    // Headings do not receive focus; locate the marked option after any group heading.
    const at = rows.findIndex((line) => line.includes(`${pointer(ctx)} `))
    return Math.max(0, at)
  }
}

export function formButton(label: string, focused: boolean, ctx: RenderContext): string {
  const text = `[ ${label} ]`
  return focused ? ctx.theme.accent(ctx.color ? inverse(text) : text) : text
}

export function formToneStyle(theme: Theme, tone: FormStatusTone | undefined) {
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
