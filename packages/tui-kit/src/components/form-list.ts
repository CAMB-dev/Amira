import type { RenderContext } from "../component.ts"
import { chromeGlyphs, defaultGlyphs } from "../glyphs.ts"
import { truncateToWidth, visibleWidth } from "../width.ts"
import type { FormChoice } from "./form.ts"

/** List rows shown at once; longer lists scroll with the highlight. */
const LIST_ROWS = 8
const INDENT = "  "

const columns = (detail: FormChoice["detail"]): string[] =>
  Array.isArray(detail) ? detail : detail ? [detail] : []

/** Size over the entire filtered list, not just the current scroll window. */
function columnWidths(rows: FormChoice[], available: number, gap: number): number[] {
  const widths: number[] = []
  let labelWidth = 0
  for (const row of rows) {
    labelWidth = Math.max(labelWidth, visibleWidth(row.label ?? row.value))
    for (const [i, text] of columns(row.detail).entries())
      widths[i] = Math.max(widths[i] ?? 0, visibleWidth(text))
  }
  // Keep labels useful; optional trailing columns disappear whole, rightmost first.
  const minimumLabel = Math.min(16, labelWidth)
  while (
    widths.length &&
    (!widths.at(-1) || widths.reduce((total, size) => total + size + gap, minimumLabel) > available)
  )
    widths.pop()
  return widths
}

/** Rows of a select's list or a checklist, scrolled to keep the highlight in view. */
export function renderFormList(
  state: { highlight: number; top: number },
  rows: FormChoice[],
  width: number,
  ctx: RenderContext,
  on: (o: FormChoice) => boolean,
  boxes = false,
  indent = INDENT,
): string[] {
  const { theme } = ctx
  const chrome = chromeGlyphs(ctx.glyphs)
  const pointer = ctx.glyphs?.pointer ?? defaultGlyphs.pointer ?? "›"
  state.highlight = Math.max(0, Math.min(state.highlight, rows.length - 1))
  if (state.highlight < state.top) state.top = state.highlight
  if (state.highlight >= state.top + LIST_ROWS) state.top = state.highlight - LIST_ROWS + 1
  state.top = Math.max(0, Math.min(state.top, rows.length - LIST_ROWS))
  const available = Math.max(0, width - visibleWidth(`${indent}${pointer} [ ] `))
  const gap = available >= 6 ? 2 : 1
  const subcolumns = boxes && rows.some((o) => Array.isArray(o.detail))
  const widths = subcolumns ? columnWidths(rows, available, gap) : []
  // A legacy string stays one truncatable right-aligned note.
  const detailWidth =
    boxes && !subcolumns
      ? Math.min(
          rows.reduce(
            (max, o) => Math.max(max, visibleWidth(typeof o.detail === "string" ? o.detail : "")),
            0,
          ),
          Math.max(0, Math.floor((available - gap) / 2)),
        )
      : 0
  const out = rows.slice(state.top, state.top + LIST_ROWS).flatMap((o, j) => {
    const heading =
      o.group && (j === 0 || rows[state.top + j - 1]?.group !== o.group)
        ? [truncateToWidth(`${indent}  ${theme.muted(o.group)}`, width, chrome.more)]
        : []
    return [...heading, renderRow()]

    function renderRow(): string {
      const hl = state.top + j === state.highlight
      const box = boxes ? `${on(o) ? "[x]" : "[ ]"} ` : on(o) ? `${chrome.optionSelected} ` : "  "
      const prefix = `${indent}${hl ? `${pointer} ` : "  "}${box}`
      const desc = o.description ? theme.muted(`  ${o.description}`) : ""
      if (widths.length) {
        const labelWidth = Math.max(0, width - visibleWidth(prefix) - widths.reduce((n, w) => n + w + gap, 0))
        const name = truncateToWidth(`${o.label ?? o.value}${desc}`, labelWidth, chrome.more)
        const label = hl ? theme.accent(prefix + name) : prefix + name
        const detail = columns(o.detail)
        if (!detail.slice(0, widths.length).some(Boolean)) return label
        const notes = widths
          .map((size, i) => {
            const text = truncateToWidth(detail[i] ?? "", size)
            return " ".repeat(Math.max(0, size - visibleWidth(text))) + text
          })
          .join(" ".repeat(gap))
        return label + " ".repeat(Math.max(0, labelWidth - visibleWidth(name)) + gap) + theme.muted(notes)
      }
      if (detailWidth && typeof o.detail === "string" && o.detail) {
        const labelWidth = Math.max(0, width - visibleWidth(prefix) - detailWidth - gap)
        const name = truncateToWidth(`${o.label ?? o.value}${desc}`, labelWidth, chrome.more)
        const detail = truncateToWidth(o.detail, detailWidth, chrome.more)
        const padding = Math.max(0, width - visibleWidth(prefix + name + detail))
        return `${hl ? theme.accent(prefix + name) : prefix + name}${" ".repeat(padding)}${theme.muted(detail)}`
      }
      return truncateToWidth(
        `${indent}${hl ? theme.accent(`${pointer} ${box}${o.label ?? o.value}`) : `  ${box}${o.label ?? o.value}`}${desc}`,
        width,
        chrome.more,
      )
    }
  })
  if (rows.length > LIST_ROWS)
    out.push(
      truncateToWidth(indent + theme.muted(`  ${state.highlight + 1}/${rows.length}`), width, chrome.more),
    )
  return out
}
