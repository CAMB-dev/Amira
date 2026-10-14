import type { ToolLine, ViewLine } from "@amira/api"
import { visibleWidth, wrapText } from "@amira/tui-kit"
import { terminalText } from "./diff-view.ts"

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
