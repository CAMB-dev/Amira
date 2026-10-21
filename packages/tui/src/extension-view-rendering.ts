import type { ToolLine, ViewLine } from "@amira/api"
import { type Glyphs, renderMarkdown, type Theme, visibleWidth, wrapText } from "@amira/tui-kit"
import { terminalText } from "./diff-view.ts"
import { replyRows } from "./format.ts"
import { glyphs } from "./glyphs.ts"

/** Host-rendered replies share the transcript gutter and link policy, including on nested pages. */
export function viewReplyRows(
  text: string,
  width: number,
  theme: Theme,
  markdownGlyphs: Glyphs | undefined,
  hyperlinks: boolean | "web" | undefined,
): string[] {
  const markers = new Set<string>()
  const rows = renderMarkdown(text, Math.max(1, width - visibleWidth(glyphs.assistant)), theme, {
    glyphs: markdownGlyphs,
    hyperlinks,
    markerOutset: 2,
    onMarkerRow: (row) => {
      markers.add(row)
    },
  })
  return replyRows(rows, markers)
}

/** Lines of text that wrap to the width; the rest (code, diffs) are cut, as tool output is. */
const WRAPPED: ReadonlySet<ToolLine["kind"]> = new Set([
  "text",
  "muted",
  "accent",
  "success",
  "warning",
  "error",
])

/**
 * Where a wrapped line's later rows start: past its indent and a leading marker such as "✗ ",
 * "● ", "- " or "12. ", so they hang under its text.
 */
const HANG = /^(\s*)((?:[^\p{L}\p{N}\s]{1,2}|\d{1,3}[.)])\s+)?/u

/**
 * View lines fitted to `width`: text lines wrapped, their later rows hanging under their text,
 * code and diff lines as they are (renderToolLines cuts them).
 */
export function wrapViewLines(lines: readonly ViewLine[], width: number): ViewLine[] {
  const out: ViewLine[] = []
  for (const l of lines) {
    // Presenter metadata needs the complete label to place its marker and description once.
    if (
      l.kind === "segments" ||
      l.kind === "user-message" ||
      l.wrap ||
      l.marker ||
      l.description !== undefined
    ) {
      out.push(l)
      continue
    }
    const text = terminalText(l.text)
    if (!WRAPPED.has(l.kind) || l.lineNo !== undefined || visibleWidth(text) <= width) {
      out.push(l)
      continue
    }
    const m = HANG.exec(text)!
    let hang = visibleWidth(m[0])
    // A marker that leaves too little room hangs nothing.
    if (width - hang < 10) hang = 0
    const rest = text.slice(m[0].length)
    const rows = hang ? wrapText(rest, width - hang) : wrapText(text, width)
    for (const [i, r] of rows.entries()) {
      out.push({ ...l, text: hang ? (i === 0 ? m[0] + r : " ".repeat(hang) + r) : r })
    }
  }
  return out
}

/** Terminal-safe text fitted to one logical line for titles and prompts. */
export function oneLine(s: string): string {
  return terminalText(s).replace(/\s+/g, " ").trim()
}
