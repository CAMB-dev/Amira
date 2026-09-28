export const ESC = "\x1b"
export const CSI = "\x1b["

export const cursor = {
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  up: (n: number) => (n > 0 ? `\x1b[${n}A` : ""),
  down: (n: number) => (n > 0 ? `\x1b[${n}B` : ""),
  /** Moves to a zero-based column on the current row. */
  column: (col: number) => `\x1b[${col + 1}G`,
  /** Moves to a zero-based row and column of the screen. */
  to: (row: number, col = 0) => `\x1b[${row + 1};${col + 1}H`,
}

export const erase = {
  line: "\x1b[2K",
  toScreenEnd: "\x1b[J",
  screen: "\x1b[2J",
}

export const RESET = "\x1b[0m"

/** A terminal mode that is switched on and off with a pair of sequences. */
export interface TerminalMode {
  on: string
  off: string
}

export const modes = {
  /** The alternate screen; entering saves the cursor and leaving restores it and the main screen. */
  altScreen: { on: "\x1b[?1049h", off: "\x1b[?1049l" },
  /**
   * Alternate scroll: on the alternate screen the mouse wheel sends ↑/↓ instead of scrolling
   * a scrollback that is not there. Unlike mouse reporting, it leaves text selection alone.
   */
  alternateScroll: { on: "\x1b[?1007h", off: "\x1b[?1007l" },
  bracketedPaste: { on: "\x1b[?2004h", off: "\x1b[?2004l" },
  win32Input: { on: "\x1b[?9001h", off: "\x1b[?9001l" },
  kittyKeyboard: { on: "\x1b[>1u", off: "\x1b[<u" },
} satisfies Record<string, TerminalMode>

export const syncOutput = {
  begin: "\x1b[?2026h",
  end: "\x1b[?2026l",
}

export const queries = {
  kittyKeyboard: "\x1b[?u",
  syncOutput: "\x1b[?2026$p",
  primaryDeviceAttributes: "\x1b[c",
}

/** Matches CSI, OSC, DCS/APC/PM/SOS strings and other escapes (`ESC 7`, `ESC c`, `ESC ( B`, ...). */
export const ANSI_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the point
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^X][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]/g

export function stripAnsi(s: string): string {
  return s.includes(ESC) ? s.replace(ANSI_PATTERN, "") : s
}
