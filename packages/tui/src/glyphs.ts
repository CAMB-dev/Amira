/**
 * Every symbol the transcript draws, in one place, so a styling pass can swap them without
 * touching the layout code. Colors come from the theme (tokens such as accent and muted).
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
  /** Starts the result line under a tool call or a command. */
  result: "⎿",
  /** Starts each live output line of a running tool. */
  output: "│",
  /** A sub-agent, and how its run ended. */
  subagent: "◆",
  subagentDone: "✓",
  subagentFailed: "✗",
  subagentAborted: "⊘",
  /** Dialog questions and their answers. */
  question: "?",
  /** System notices by level. */
  info: "•",
  success: "✓",
  warning: "⚠",
  error: "✗",
  interrupted: "⊘",
  /** Marks text left out. */
  more: "…",
  /** The rule of separators such as the one after a resumed history. */
  rule: "─",
} as const

export type Glyphs = typeof glyphs
