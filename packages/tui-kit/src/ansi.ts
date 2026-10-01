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
  /**
   * Mouse reporting of presses, releases and the wheel (1000) in the SGR encoding (1006), so
   * positions past column 223 work. While it is on, the terminal leaves selecting text to
   * Shift+drag (Windows Terminal, VS Code, xterm and most others).
   */
  mouse: { on: "\x1b[?1000h\x1b[?1006h", off: "\x1b[?1006l\x1b[?1000l" },
  /**
   * Button-event tracking (1002): with mouse reporting on, also the moves of the mouse while a
   * button is held, reported as drags. Moves without a button are not sent. xterm, kitty and
   * iTerm2 keep 1000 and 1002 as one setting, which leaving 1002 turns off: leaving it asks
   * for 1000 again, so it is left before `mouse` is.
   */
  mouseDrag: { on: "\x1b[?1002h", off: "\x1b[?1002l\x1b[?1000h" },
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
  /** XTWINOPS 16: the size of a cell in pixels, answered with CSI 6 ; height ; width t. */
  cellPixels: "\x1b[16t",
  /** XTWINOPS 14: the text area in pixels, answered with CSI 4 ; height ; width t. */
  windowPixels: "\x1b[14t",
  /** kitty graphics: a query that shows nothing, answered with APC G i=31;OK ST where supported. */
  kittyGraphics: "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\",
  /** OSC 11: the default background color, answered with OSC 11 ; rgb:RRRR/GGGG/BBBB and BEL or ST. */
  background: "\x1b]11;?\x07",
}

// One escape-sequence matcher for the workspace, shared with the width code.
export { ANSI_PATTERN, stripAnsi } from "@amira/text-width"
