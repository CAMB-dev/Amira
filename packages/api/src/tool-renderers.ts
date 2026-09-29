import type { ToolRejection } from "./events.ts"
import type { DiffHunk } from "./tool-details.ts"
import type { ToolResult } from "./tools.ts"

/**
 * Experimental (D1): how frontends present a tool's calls. Presenters describe lines by what
 * they mean, never by color, so the TUI maps them to its theme and other frontends can reuse
 * them. The shape may still change before it is declared stable.
 */

/** What a line is, which decides how a frontend styles it. */
export type ToolLineKind =
  | "text"
  | "muted"
  | "accent"
  | "success"
  | "warning"
  | "error"
  /** Program output or file content, shown as is. */
  | "code"
  /** Unified diff lines; `text` is the line without its +, - or space. */
  | "diff-add"
  | "diff-remove"
  | "diff-context"
  /** A hunk header or a gap between hunks. */
  | "diff-hunk"

export interface ToolLine {
  kind: ToolLineKind
  /** Plain text: no escape sequences, no line breaks. */
  text: string
  /** A line number to show in a gutter, for diffs and file content. */
  lineNo?: number
}

/**
 * How much of a finished call the frontend shows: `collapsed` is the head and a one-line
 * result, `summary` adds a short body (failures and diffs), `full` everything there is.
 */
export type ToolDetailLevel = "collapsed" | "summary" | "full"

/** A finished tool call, as a presenter sees it. */
export interface ToolCallView<A = Record<string, unknown>, D = unknown> {
  args: A
  result: ToolResult & { details?: D }
  /** The result's text blocks joined with newlines, trimmed. */
  text: string
  /** Unknown for calls from a resumed session. */
  durationMs?: number
  rejected?: ToolRejection
}

export interface ToolBodyOptions {
  detail: ToolDetailLevel
  /** Columns available for each line. */
  width: number
}

/**
 * Presents one tool's calls. Every method is optional; frontends fall back to a generic
 * presentation for what a presenter leaves out, and for calls a method throws on.
 */
export interface ToolPresenter<A = Record<string, unknown>, D = unknown> {
  /** The call's head after the tool name: the arguments that matter, e.g. a path or a command. */
  summary?(args: A): string
  /**
   * One line about the outcome, e.g. "12 lines" or "exit 1 · 5 lines". Undefined falls back to
   * the first line of the result.
   */
  result?(call: ToolCallView<A, D>): string | undefined
  /**
   * Lines under the result: a diff, the output of a failed command. Return all of them; the
   * frontend cuts them to fit `detail`.
   */
  body?(call: ToolCallView<A, D>, opts: ToolBodyOptions): ToolLine[]
  /**
   * Lines shown while the call runs, from its latest tool.execute.update (undefined before the
   * first). Frontends show at most three. Defaults to the last lines of the partial result.
   */
  running?(args: A, partial: ToolResult | undefined): ToolLine[]
}

/**
 * Diff hunks as presenter lines, numbered with the new file's line numbers (the old one's for
 * removed lines), with a `diff-hunk` line between hunks.
 */
export function diffToolLines(hunks: readonly DiffHunk[]): ToolLine[] {
  const out: ToolLine[] = []
  for (const [i, h] of hunks.entries()) {
    if (i > 0) out.push({ kind: "diff-hunk", text: "⋯" })
    let oldNo = h.oldStart
    let newNo = h.newStart
    for (const line of h.lines) {
      const text = line.slice(1)
      if (line.startsWith("+")) out.push({ kind: "diff-add", text, lineNo: newNo++ })
      else if (line.startsWith("-")) out.push({ kind: "diff-remove", text, lineNo: oldNo++ })
      else {
        out.push({ kind: "diff-context", text, lineNo: newNo++ })
        oldNo++
      }
    }
  }
  return out
}

/** The text blocks of a tool result joined with newlines and trimmed; images as placeholders. */
export function toolResultText(result: ToolResult): string {
  return result.content
    .map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`))
    .join("\n")
    .trim()
}
