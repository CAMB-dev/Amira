import type { StyleFn, Theme } from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"

/** What a block of the transcript is; the spacing rule depends on it. */
export type BlockKind =
  | "banner"
  | "user"
  | "assistant"
  | "tool"
  | "notice"
  | "command"
  | "command-output"
  | "dialog"
  | "history"

/** Blocks that follow one of the given kind with no blank line between them. */
const JOINS: Partial<Record<BlockKind, BlockKind>> = {
  // Tool calls of one step read as a list.
  tool: "tool",
  // What a command prints hangs under its echo.
  "command-output": "command",
}

/**
 * The transcript's spacing rule, in one place: exactly one blank line between blocks, none
 * between blocks that belong together (the tool calls of a step, a command and its output).
 * It only decides the lines; the caller commits them (they go to the scrollback once) and
 * uses `gapBefore` to draw what is still live the way it will be committed.
 */
export class Transcript {
  #last: BlockKind | undefined
  /** A block still being written, such as a streaming reply; more of it follows without a gap. */
  #open: BlockKind | undefined

  /** The kind of the last block committed. */
  get last(): BlockKind | undefined {
    return this.#last
  }

  /** Whether a block of `kind` starting now gets a blank line before it. */
  gapBefore(kind: BlockKind): boolean {
    if (this.#open === kind) return false
    if (this.#last === undefined) return false
    return JOINS[kind] !== this.#last
  }

  /** The lines to commit for a whole block: a blank line first when the rule wants one. */
  block(kind: BlockKind, lines: string[]): string[] {
    const gap = this.gapBefore(kind)
    this.#last = kind
    this.#open = undefined
    return gap ? ["", ...lines] : lines
  }

  /** Lines that continue the open block of `kind`, or start it: e.g. finished rows of a reply. */
  continue(kind: BlockKind, lines: string[]): string[] {
    if (!lines.length) return []
    if (this.#open === kind) return lines
    const out = this.block(kind, lines)
    this.#open = kind
    return out
  }

  /** Ends the open block; what follows is a new one. */
  end(): void {
    this.#open = undefined
  }
}

export type NoticeLevel = "info" | "success" | "warning" | "error" | "interrupted"

/**
 * A system notice (interrupted, compacted, an extension error, ...): a symbol by level, then
 * the text; later lines are indented under the first.
 */
export function noticeLines(theme: Theme, level: NoticeLevel, text: string): string[] {
  const style: StyleFn = level === "error" ? theme.error : level === "warning" ? theme.warning : theme.muted
  const glyph = level === "success" ? theme.success(glyphs.success) : style(glyphs[level])
  return text.split("\n").map((l, i) => (i === 0 ? `${glyph} ${style(l)}` : `  ${style(l)}`))
}

/** Output of a command, hanging under its echo like a tool's result. */
export function commandOutputLines(style: StyleFn, muted: StyleFn, text: string): string[] {
  return text.split("\n").map((l, i) => `  ${i === 0 ? muted(glyphs.result) : " "} ${style(l)}`)
}
