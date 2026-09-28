/**
 * Symbols the TUI draws, in one place so a styling pass can swap them. Each must be one cell
 * wide in the terminals Amira supports (Windows Terminal, VS Code, and common Unix ones).
 */
export const Glyphs = {
  /** Before the selected option of a list, and the dialog's own echo in the transcript. */
  pointer: "›",
  /** Before a dialog's title. */
  question: "?",
  /** Where text was cut short. */
  ellipsis: "…",
  /** Marks the terminal title while a turn runs. */
  working: "●",
  /** Before the branch in the terminal title. */
  branch: "⎇",
  /** Between items of a hint or the title. */
  separator: "·",
}
