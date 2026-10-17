import type { RenderContext } from "../component.ts"
import { chromeGlyphs, defaultGlyphs } from "../glyphs.ts"
import { keyLabel } from "../keys.ts"
import { truncateToWidth, visibleWidth } from "../width.ts"
import type { FormStatusTone } from "./form.ts"
import { type FormFieldState, formButton, formToneStyle } from "./form-field.ts"
import { wrapFormHint } from "./form-hint.ts"
import type { FormHit } from "./form-mouse.ts"

export const SUBMIT = "\0submit"
export const CANCEL = "\0cancel"
export const PREVIEW = "\0preview"
const pointer = (ctx: RenderContext) => ctx.glyphs?.pointer ?? defaultGlyphs.pointer ?? "›"
const separator = (ctx: RenderContext) => ctx.glyphs?.separator ?? defaultGlyphs.separator ?? "·"

interface FooterState {
  focus: string
  field?: FormFieldState
  confirming: boolean
  bad: number
  status?: { text: string; tone: FormStatusTone }
  actions: FormFieldState[]
  submitLabel?: string
  notice: string[]
  hintInset: number
}

/** The fixed action strip; all targets use the same rows as their displayed buttons. */
export function renderFormFooter(
  width: number,
  ctx: RenderContext,
  hits: FormHit[],
  state: FooterState,
): string[] {
  const { theme } = ctx
  const chrome = chromeGlyphs(ctx.glyphs)
  const out = [theme.border((ctx.glyphs?.rule ?? "─").repeat(width))]
  for (const n of state.notice) out.push(theme.warning(truncateToWidth(n, width, chrome.more)))
  if (state.confirming) {
    const text = `Discard your changes? y discard ${separator(ctx)} n keep editing`
    const shown = truncateToWidth(text, width, chrome.more)
    for (const [value, label] of [
      ["y", "y discard"],
      ["n", "n keep editing"],
    ] as const)
      if (shown.includes(label))
        hits.push({
          focus: CANCEL,
          kind: "confirm",
          value,
          x: visibleWidth(text.slice(0, text.indexOf(label))),
          y: out.length,
          width: visibleWidth(label),
          height: 1,
        })
    out.push(theme.warning(shown))
    return out
  }
  if (state.bad)
    out.push(
      theme.error(
        truncateToWidth(
          `Fix ${state.bad === 1 ? "1 field" : `${state.bad} fields`} before saving.`,
          width,
          chrome.more,
        ),
      ),
    )
  if (state.status)
    out.push(formToneStyle(theme, state.status.tone)(truncateToWidth(state.status.text, width, chrome.more)))
  for (const f of state.actions) {
    const action = f.action
    if (action?.running || action?.text) {
      const text = action.running
        ? `${chrome.more} ${action.text ?? "working"} ${separator(ctx)} Esc stops it`
        : action.text!
      out.push(formToneStyle(theme, action.tone)(truncateToWidth(text, width, chrome.more)))
    }
  }
  const buttons: [string, string][] = [
    ...state.actions.map((f): [string, string] => [f.def.id, f.def.buttonLabel ?? f.def.label]),
    [SUBMIT, state.submitLabel ?? "Save"],
    [CANCEL, "Cancel"],
  ]
  let row = ""
  for (const [focus, label] of buttons) {
    const focused = state.focus === focus
    const mark = focused ? theme.accent(pointer(ctx)) : " "
    const text = formButton(label, focused, ctx)
    if (
      state.actions.length &&
      row &&
      visibleWidth(row) + visibleWidth(mark) + 1 + visibleWidth(text) > width
    ) {
      out.push(row.trimEnd())
      row = ""
    }
    const x = visibleWidth(row) + visibleWidth(mark) + 1
    // A clipped button is not actionable, and the gap between the buttons is inert.
    if (x + visibleWidth(text) <= width)
      hits.push({ focus, kind: "activate", x, y: out.length, width: visibleWidth(text), height: 1 })
    row += `${mark} ${text}  `
  }
  out.push(truncateToWidth(row.trimEnd(), width))
  const hint = formHint(ctx, state.focus, state.field)
  const hintWidth = Math.max(0, width - state.hintInset)
  const hintRow = (line: string) => " ".repeat(state.hintInset) + theme.muted(line)
  if (state.field?.def.type === "multiselect" && width >= 40 && ctx.rows >= 10) {
    for (const line of wrapFormHint(hint, hintWidth, ` ${separator(ctx)} `)) out.push(hintRow(line))
  } else out.push(hintRow(truncateToWidth(hint, hintWidth, chrome.more)))
  return out
}

function formHint(ctx: RenderContext, focus: string, f: FormFieldState | undefined): string {
  const sep = separator(ctx)
  const enter = keyLabel({ name: "enter" })
  const esc = keyLabel({ name: "escape" })
  const tab = keyLabel({ name: "tab" })
  const space = keyLabel({ name: "space" })
  const save = keyLabel({ name: "s", ctrl: true })
  const arrows = chromeGlyphs(ctx.glyphs)
  const pair = (a: string, b: string) => a + (a.length > 1 || b.length > 1 ? "/" : "") + b
  const vertical = pair(arrows.arrowUp, arrows.arrowDown)
  const horizontal = pair(arrows.arrowLeft, arrows.arrowRight)
  const common = `${tab}/${vertical} move ${sep} ${save} save ${sep} ${esc} cancel`
  if (focus === PREVIEW)
    return `${vertical}/PgUp/PgDn scroll preview ${sep} ${tab} move ${sep} ${save} save ${sep} ${esc} cancel`
  if (!f)
    return focus.startsWith("\0section:")
      ? `${enter}/${space} expand or collapse ${sep} ${horizontal} open/close ${sep} ${common}`
      : `${enter} press ${sep} ${common}`
  switch (f.def.type) {
    case "select":
      return f.open
        ? `${vertical} pick ${sep} type to filter ${sep} ${enter} choose ${sep} ${esc} close`
        : `${enter} list ${sep} ${horizontal} change ${sep} ${common}`
    case "multiselect":
      return `${space} toggle ${sep} type to filter${f.def.allowCustom ? " or add" : ""} ${sep} ${keyLabel({ name: "a", ctrl: true })} all/none filtered options ${sep} ${keyLabel({ name: "x", ctrl: true })} invert filtered options ${sep} ${common}`
    case "checkbox":
      return `${space} toggle ${sep} ${common}`
    case "textarea":
      return `${keyLabel({ name: "enter", shift: true })} newline ${sep} ${enter} next ${sep} ${common}`
    case "action":
      return f.action?.running
        ? `${esc} stop ${sep} ${tab}/${vertical} move ${sep} ${save} save`
        : `${enter} run ${sep} ${common}`
    default:
      return `${enter} next ${sep} ${common}`
  }
}
