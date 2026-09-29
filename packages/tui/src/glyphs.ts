/**
 * Every symbol the TUI draws, in one place, so a styling pass can swap them without touching
 * the layout code. Colors come from the theme (tokens such as accent and muted). Each must be
 * one cell wide in the terminals Amira supports (Windows Terminal, VS Code, and common Unix ones),
 * so none has an emoji form (the Unicode Emoji property): terminals draw those from the emoji
 * font, two cells wide (see `textWidth` in tui-kit). A test checks that.
 */
export const glyphs = {
  /** In front of the user's messages and echoed commands. */
  user: "›",
  /** Indents every row of the assistant's replies, setting them apart from everything else. */
  assistant: "  ",
  /** Tool calls: finished, failed, and ended without running to completion. */
  toolDone: "●",
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
  /** A row of a tree with more rows after it at the same level. */
  treeBranch: "├",
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
  /** The rule of separators such as the one after a resumed history. */
  rule: "─",
  /** Before the selected row of a list (dialogs, completion lists), and a dialog's echo. */
  pointer: "›",
  /** Starts the history search line, and sits between its label and the query. */
  search: "⌕",
  searchPrompt: "›",
  /** Marks the terminal title while a turn runs. */
  working: "●",
  /**
   * Before the branch in the terminal title, which the title bar draws in the system's font.
   * Not for the grid: Cascadia Code and Mono lack "⎇" (U+2387) and the fallback font draws it
   * out of line, so the status shows the branch without a symbol.
   */
  branch: "⎇",
  /** Between items of a hint or the title. */
  separator: "·",
} as const

export type Glyphs = typeof glyphs
