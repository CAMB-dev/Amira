export const ESC = "\x1b"
export const CSI = "\x1b["

export const cursor = {
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  up: (n: number) => (n > 0 ? `\x1b[${n}A` : ""),
  down: (n: number) => (n > 0 ? `\x1b[${n}B` : ""),
  /** Moves to a zero-based column on the current row. */
  column: (col: number) => `\x1b[${col + 1}G`,
}

export const erase = {
  line: "\x1b[2K",
  toScreenEnd: "\x1b[J",
}

export const RESET = "\x1b[0m"

/** A terminal mode that is switched on and off with a pair of sequences. */
export interface TerminalMode {
  on: string
  off: string
}

export const modes = {
  altScreen: { on: "\x1b[?1049h", off: "\x1b[?1049l" },
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

/** Matches CSI, OSC, DCS/APC/PM/SOS strings and two-byte escapes. */
export const ANSI_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the point
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^X][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export function stripAnsi(s: string): string {
  return s.includes(ESC) ? s.replace(ANSI_PATTERN, "") : s
}
