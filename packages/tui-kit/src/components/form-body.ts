import type { RenderContext } from "../component.ts"
import { chromeGlyphs, defaultGlyphs } from "../glyphs.ts"
import { bold } from "../style.ts"
import { truncateToWidth, visibleWidth, wrapText } from "../width.ts"
import type { FormOptions } from "./form.ts"
import { type FormFieldState as FieldState, formButton, renderFormField } from "./form-field.ts"
import { PREVIEW, SUBMIT } from "./form-footer.ts"
import type { FormHit } from "./form-mouse.ts"
import { filteredFormChoices, formChecklistRows } from "./form-state.ts"

export interface FormSpan {
  start: number
  end: number
  active: number
}

interface BodyState {
  shown: FieldState[]
  opts: FormOptions
  cardLayout: boolean
  collapsed: Set<string>
  expandedSummaries: Set<string>
  focus: string
  shownError(id: string): string | undefined
  previewExpanded: boolean
  previewTop: number
  previewLength: number
}

const INDENT = "  "
const pointer = (ctx: RenderContext) => ctx.glyphs?.pointer ?? defaultGlyphs.pointer ?? "›"

export function renderFormBody(
  width: number,
  ctx: RenderContext,
  preview: string[],
  card: boolean,
  state: BodyState,
): { lines: string[]; spans: Map<string, FormSpan>; hits: FormHit[]; previewLength: number } {
  const { theme } = ctx
  const chrome = chromeGlyphs(ctx.glyphs)
  const lines: string[] = []
  const spans = new Map<string, FormSpan>()
  const hits: FormHit[] = []
  const inlineActions = (id: string) =>
    state.cardLayout
      ? state.shown.filter(
          (f) => f.def.type === "action" && f.def.inline === id && f.def.placement !== "footer",
        )
      : []
  const shown = state.shown.filter(
    (f) =>
      f.def.type !== "action" ||
      (f.def.placement !== "footer" &&
        !(
          state.cardLayout &&
          state.shown.some((target) => target.def.type === "multiselect" && target.def.id === f.def.inline)
        )),
  )
  if (card && state.opts.description)
    for (const line of wrapText(state.opts.description, width - 4)) lines.push(INDENT + theme.muted(line))
  const labelWidth = Math.min(
    24,
    Math.max(0, ...shown.map((f) => visibleWidth(f.def.label) + (f.def.required ? 2 : 0))),
  )
  const stacked = !card && width - labelWidth - 6 < 20
  const column = stacked ? Math.min(2, Math.max(0, width - 3)) : labelWidth + (card ? 5 : 4)
  const rowRule = () =>
    theme.border(
      (ctx.glyphs?.rule ?? defaultGlyphs.rule).repeat(card ? column - 2 : width) +
        (card
          ? (ctx.glyphs?.tableCross ?? defaultGlyphs.tableCross) +
            (ctx.glyphs?.rule ?? defaultGlyphs.rule).repeat(width - column + 1)
          : ""),
    )
  let section: string | undefined
  const summaries = new Set<string>()
  for (const f of shown) {
    const group = state.cardLayout
      ? state.opts.summaries?.find((item) => item.fields.includes(f.def.id))
      : undefined
    if (group && summaries.has(group.id) && !state.expandedSummaries.has(group.id)) continue
    if (card && f.def.section === section && (!section || !state.collapsed.has(section)) && lines.length)
      lines.push(rowRule())
    const start = lines.length
    if (f.def.section !== section) {
      section = f.def.section
      if (section) {
        if (lines.length)
          lines.push(card ? theme.border((ctx.glyphs?.rule ?? defaultGlyphs.rule).repeat(width)) : "")
        const def = state.opts.sections?.find((s) => s.title === section)
        const id = sectionId(section)
        const disclosure =
          def?.collapsed !== undefined
            ? `${state.collapsed.has(section) ? chrome.disclosureClosed : chrome.disclosureOpen} `
            : ""
        const focused = state.focus === id
        const title = truncateToWidth(`${disclosure}${section}`, Math.max(1, width - 4), chrome.more)
        const rule = (ctx.glyphs?.rule ?? "─").repeat(Math.max(0, width - visibleWidth(title) - 3))
        if (def?.collapsed !== undefined)
          hits.push({
            focus: id,
            kind: "activate",
            x: 0,
            y: lines.length,
            width: Math.min(width, visibleWidth(title) + 2),
            height: 1,
          })
        lines.push(
          `${focused ? theme.accent(ctx.color ? bold(pointer(ctx)) : pointer(ctx)) : " "} ${focused ? theme.accent(bold(title)) : bold(title)} ${theme.border(rule)}`,
        )
        if (!state.collapsed.has(section) && def?.help)
          for (const line of wrapText(def.help, Math.max(1, width - 2)))
            lines.push(INDENT + theme.muted(line))
        if (!card) lines.push("")
        spans.set(id, { start, end: lines.length, active: start + (start ? 1 : 0) })
      }
    }
    if (section && state.collapsed.has(section)) continue
    const summary = state.cardLayout
      ? state.opts.summaries?.find((item) => item.fields.includes(f.def.id))
      : undefined
    if (summary && !summaries.has(summary.id)) {
      summaries.add(summary.id)
      const id = summaryId(summary.id)
      const focused = state.focus === id
      const label = `${focused ? pointer(ctx) : " "} ${summary.label}`
      const button = formButton("Edit", focused, ctx)
      const text = `${label} ${truncateToWidth(summary.text, Math.max(1, width - visibleWidth(label) - visibleWidth(button) - 2), chrome.more)} ${button}`
      hits.push({ focus: id, kind: "activate", x: 0, y: lines.length, width, height: 1 })
      spans.set(id, { start: lines.length, end: lines.length + 1, active: lines.length })
      lines.push(text)
    }
    if (summary && !state.expandedSummaries.has(summary.id)) continue
    const at = lines.length
    const bulk = bulkField(state.focus)
    const actions = inlineActions(f.def.id)
    const own = renderFormField(
      f,
      width,
      column,
      stacked,
      ctx,
      state.focus === f.def.id ||
        bulk?.id === f.def.id ||
        actions.some((action) => action.def.id === state.focus),
      state.shownError(f.def.id),
      {
        filtered: filteredFormChoices(f),
        checklist: f.def.type === "multiselect" ? formChecklistRows(f) : [],
        total: f.def.type === "multiselect" ? formChecklistRows(f, "").length : 0,
        bulk: bulk?.id === f.def.id ? bulk.action : undefined,
        buttons: state.cardLayout,
        actions,
        actionFocus: state.focus,
      },
      (hit) => {
        hits.push({
          ...hit,
          focus:
            hit.focus ?? (hit.kind === "bulk" ? bulkId(f.def.id, hit.value as "all" | "none") : f.def.id),
          y: at + hit.y,
        })
        if (f.editor && hit.kind === "focus" && hit.y >= (stacked ? 1 : 0)) {
          const edge = width - column >= 3 ? 1 : 0
          hits.push({
            focus: f.def.id,
            kind: "editor",
            x: column + edge,
            y: at + hit.y,
            width: Math.max(1, width - column - edge * 2),
            height: 1,
            editorY: hit.y - (stacked ? 1 : 0),
          })
        }
      },
      card,
    )
    lines.push(...own.lines)
    spans.set(f.def.id, { start, end: lines.length, active: at + own.active })
    for (const action of actions) spans.set(action.def.id, { start, end: lines.length, active: at })
    if (state.cardLayout && f.def.type === "multiselect") {
      const span = { start, end: lines.length, active: at }
      spans.set(bulkId(f.def.id, "all"), span)
      spans.set(bulkId(f.def.id, "none"), span)
    }
  }
  const previewStart = lines.length
  if (preview.length && state.cardLayout) {
    lines.push(card ? theme.border((ctx.glyphs?.rule ?? defaultGlyphs.rule).repeat(width)) : "")
    const disclosure = state.previewExpanded ? chrome.disclosureOpen : chrome.disclosureClosed
    const title = `${disclosure} Preview settings.json (${preview.length} lines)`
    hits.push({
      focus: PREVIEW,
      kind: "activate",
      x: 2,
      y: lines.length,
      width: Math.min(width - 2, visibleWidth(title)),
      height: 1,
    })
    lines.push(INDENT + bold(title))
    if (state.previewExpanded)
      for (const line of preview)
        for (const wrapped of wrapText(line, Math.max(1, width - 2)))
          lines.push(INDENT + theme.muted(wrapped))
  } else if (preview.length) {
    lines.push(
      card ? theme.border((ctx.glyphs?.rule ?? defaultGlyphs.rule).repeat(width)) : "",
      state.focus === PREVIEW
        ? `${theme.accent(pointer(ctx))} ${theme.accent(bold("Preview"))}`
        : INDENT + bold("Preview"),
    )
    for (const line of preview)
      for (const wrapped of wrapText(line, Math.max(1, width - 2))) lines.push(INDENT + theme.muted(wrapped))
  }
  if (preview.length && !state.cardLayout) {
    state.previewLength = lines.length - previewStart - 1
    hits.push({
      focus: PREVIEW,
      kind: "focus",
      x: 0,
      y: previewStart + 1,
      width,
      height: state.previewLength,
    })
  }
  spans.set(PREVIEW, {
    start: previewStart,
    end: lines.length,
    active: preview.length
      ? previewStart + 1 + Math.min(state.previewTop, Math.max(0, state.previewLength - 1))
      : Math.max(0, lines.length - 1),
  })
  if (!card)
    spans.set(SUBMIT, { start: previewStart, end: lines.length, active: Math.max(0, lines.length - 1) })
  return { lines, spans, hits, previewLength: state.previewLength }
}

export function sectionId(title: string): string {
  return `\0section:${title}`
}

export function bulkId(id: string, action: "all" | "none"): string {
  return `\0bulk:${action}:${id}`
}

export function bulkField(focus: string): { id: string; action: "all" | "none" } | undefined {
  const match = focus.match(/^\0bulk:(all|none):(.+)$/)
  return match ? { id: match[2]!, action: match[1] as "all" | "none" } : undefined
}

export function summaryId(id: string): string {
  return `\0summary:${id}`
}
