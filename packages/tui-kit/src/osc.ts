import type { TerminalMode } from "./ansi.ts"

/**
 * Terminal integration beyond drawing: the window title, the taskbar/tab progress indicator,
 * the bell and focus reports. Terminals that do not know a sequence ignore it.
 */

/** Focus reporting: the terminal sends CSI I when it gains focus and CSI O when it loses it. */
export const focusReporting: TerminalMode = { on: "\x1b[?1004h", off: "\x1b[?1004l" }

/**
 * What the progress indicator shows (ConEmu's OSC 9;4, which Windows Terminal draws on the
 * tab and the taskbar button): nothing, a percentage, an error, busy without a percentage, or
 * paused (yellow in Windows Terminal).
 */
export type ProgressState = "none" | "normal" | "error" | "indeterminate" | "paused"

const PROGRESS_CODES: Record<ProgressState, number> = {
  none: 0,
  normal: 1,
  error: 2,
  indeterminate: 3,
  paused: 4,
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g

export const osc = {
  /** Sets the window and tab title (OSC 0). Control characters are dropped. */
  title: (text: string) => `\x1b]0;${text.replace(CONTROL, "")}\x07`,
  /**
   * Saves and restores the title on the terminal's title stack (XTWINOPS 22/23), so the one
   * the shell had comes back on exit. Where the stack is missing, an empty title does it.
   */
  pushTitle: "\x1b[22;0t",
  popTitle: "\x1b[23;0t",
  /** The progress indicator; `percent` only matters for "normal", "error" and "paused". */
  progress: (state: ProgressState, percent = 0) =>
    `\x1b]9;4;${PROGRESS_CODES[state]};${Math.max(0, Math.min(100, Math.round(percent)))}\x07`,
  bell: "\x07",
}

type Env = Record<string, string | undefined>

/**
 * Whether OSC 9;4 is known to mean progress here: Windows Terminal, ConEmu, VS Code and
 * Ghostty. Elsewhere it is left out, since iTerm2 shows OSC 9 as a notification.
 */
export function progressSupported(env: Env = process.env): boolean {
  if (env.TERM_PROGRAM === "iTerm.app") return false
  return (
    !!env.WT_SESSION || !!env.ConEmuPID || env.TERM_PROGRAM === "vscode" || env.TERM_PROGRAM === "ghostty"
  )
}
