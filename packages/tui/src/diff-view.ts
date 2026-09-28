import type { ToolLine } from "@amira/api"
import {
  type Component,
  type RenderContext,
  type StyleFn,
  stripAnsi,
  type Theme,
  truncateToWidth,
} from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"

const SIGNS: Partial<Record<ToolLine["kind"], string>> = {
  "diff-add": "+",
  "diff-remove": "-",
  "diff-context": " ",
}

function styleOf(kind: ToolLine["kind"], theme: Theme): StyleFn {
  switch (kind) {
    case "diff-add":
    case "success":
      return theme.success
    case "diff-remove":
    case "error":
      return theme.error
    case "diff-hunk":
    case "accent":
      return theme.accent
    case "warning":
      return theme.warning
    case "text":
      return theme.text
    default:
      // Output, file content and context recede behind the conversation.
      return theme.muted
  }
}

/**
 * Presenter lines as terminal rows, one row each, cut to `width` after `indent`. Diff lines
 * get their sign and, when numbered, a gutter as wide as the largest number.
 */
export function renderToolLines(lines: ToolLine[], theme: Theme, width: number, indent = ""): string[] {
  const numbered = lines.filter((l) => l.lineNo !== undefined)
  const gutter = numbered.length ? Math.max(...numbered.map((l) => String(l.lineNo).length)) : 0
  return lines.map((l) => {
    const text = stripAnsi(l.text)
      .replace(/[\r\n]+/g, " ")
      .replace(/\t/g, "  ")
    const sign = SIGNS[l.kind] ?? ""
    const no = gutter
      ? `${l.lineNo === undefined ? " ".repeat(gutter) : String(l.lineNo).padStart(gutter)} `
      : ""
    const row = truncateToWidth(`${indent}${no}${sign}${text}`, width, glyphs.more)
    // The gutter stays muted; the sign and text take the line's style.
    const body = row.slice(indent.length + no.length)
    return `${indent}${theme.muted(no)}${styleOf(l.kind, theme)(body)}`
  })
}

/** A unified diff as presenter lines: file headers muted, hunk headers, then +, - and context. */
export function parseUnifiedDiff(diff: string): ToolLine[] {
  return diff
    .replace(/\n$/, "")
    .split("\n")
    .map((line): ToolLine => {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff "))
        return { kind: "muted", text: line }
      if (line.startsWith("@@")) return { kind: "diff-hunk", text: line }
      if (line.startsWith("+")) return { kind: "diff-add", text: line.slice(1) }
      if (line.startsWith("-")) return { kind: "diff-remove", text: line.slice(1) }
      if (line.startsWith(" ")) return { kind: "diff-context", text: line.slice(1) }
      return { kind: "text", text: line }
    })
}

/** A diff cut to `maxLines`, with a line saying how many more there are. */
export class DiffView implements Component {
  constructor(
    private lines: ToolLine[],
    public maxLines = Number.POSITIVE_INFINITY,
  ) {}

  render(width: number, ctx: RenderContext): string[] {
    const shown = this.lines.length > this.maxLines ? this.lines.slice(0, this.maxLines) : this.lines
    const out = renderToolLines(shown, ctx.theme, width)
    if (shown.length < this.lines.length) {
      out.push(ctx.theme.muted(`${glyphs.more} ${this.lines.length - shown.length} more lines`))
    }
    return out
  }
}
