/**
 * Every symbol the TUI draws, in one place, so a styling pass can swap them without touching
 * the layout code. Colors come from the theme (tokens such as accent and muted). Most are one
 * cell wide in the terminals Amira supports (Windows Terminal, VS Code, and common Unix ones),
 * so none has an emoji form (the Unicode Emoji property) that terminals would draw from the
 * emoji font, two cells wide (see `textWidth` in tui-kit), with one exception: the warning is
 * the ⚠️ emoji, asked for with VS16 and two cells wide. Layouts measure a glyph with
 * `textWidth` (rows hanging under a warning start a cell further in) rather than assuming one
 * cell. A test checks both.
 */
const defaults = {
  /** In front of the user's messages and echoed commands. */
  user: "›",
  /** Indents every row of the assistant's replies, setting them apart from everything else. */
  assistant: "  ",
  /** Tool calls: finished, failed, and ended without running to completion. */
  toolDone: "✓",
  toolRunning: "●",
  toolFailed: "✗",
  toolInterrupted: "⊘",
  toolBlocked: "⊘",
  toolUnknown: "⊘",
  toolInvalid: "⊘",
  /**
   * Starts the result line under a tool call or a command, and the last row of a tree. Box
   * drawing, not "⎿" (U+23BF): monospace fonts such as Cascadia lack that one, and the fallback
   * font draws it wider than a cell, out of line with the "│" below it.
   */
  result: "└",
  /** A row of a tool tree with more rows after it at the same level (one cell; ASCII themes may use two). */
  treeBranch: "├",
  /** The last tool at its level (one cell; ASCII themes may use two). */
  treeLast: "└",
  /** Continues a tool tree beside result, output and diff rows (one cell). */
  treePipe: "│",
  /** Output tokens on the turn status row. */
  turnOutput: "⇣",
  /** Starts each live output line of a running tool. */
  output: "│",
  /** A sub-agent, and how its run ended. */
  subagent: "◆",
  subagentDone: "✓",
  subagentFailed: "✗",
  subagentAborted: "⊘",
  /** What the model thought before it answered. */
  thought: "∴",
  /** Dialog questions and their answers. */
  question: "?",
  /**
   * Runs down the left of a dialog (a question the user answers inline) and its echo. Box
   * drawing, so it joins into one line from row to row.
   */
  dialogBar: "┃",
  /** Before the selected option of a dialog. */
  choice: "❯",
  /**
   * An option of a multi-select dialog, chosen or not. ASCII rather than ☐/☒: fonts such as
   * Cascadia lack those, and the fallback font draws them wider than a cell.
   */
  checked: "[x]",
  unchecked: "[ ]",
  /**
   * System notices by level. The warning is the ⚠️ emoji, two cells: VS16 asks for its emoji
   * form, which is what terminals draw anyway, and is measured as such.
   */
  info: "•",
  success: "✓",
  warning: "⚠\uFE0F",
  error: "✗",
  interrupted: "⊘",
  /** Marks text left out. */
  more: "…",
  /** Finished tool content available by unfolding. */
  folded: "▸",
  /** The rule of separators such as the one after a resumed history. */
  rule: "─",
  /** Frame corners, also shared with tui-kit input boxes. */
  boxTopLeft: "╭",
  boxTopRight: "╮",
  boxBottomLeft: "╰",
  boxBottomRight: "╯",
  /** Before the selected row of a list (dialogs, completion lists), and a dialog's echo. */
  pointer: "❯",
  /** Starts the history search line, and sits between its label and the query. */
  search: "⌕",
  searchPrompt: "›",
  /** Marks the terminal title while a turn runs. */
  working: "●",
  /**
   * Before the branch in the header and terminal title. Font-limited themes can replace it.
   */
  branch: "⎇",
  /** Between items of a hint or the title. */
  separator: "·",
} as const

export type Glyphs = { -readonly [K in keyof typeof defaults]: string }

/** Shared by the terminal UI's formatting helpers; one interactive UI owns these at a time. */
export const glyphs: Glyphs = { ...defaults }

/** Definitions are validated by the core registry; absent keys always reset to the defaults. */
export function setGlyphs(overrides: Partial<Glyphs> = {}): void {
  for (const key of Object.keys(defaults) as (keyof Glyphs)[]) {
    glyphs[key] = overrides[key] ?? defaults[key]
  }
}
