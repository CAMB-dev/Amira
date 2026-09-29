/**
 * The characters components draw with, kept in one place so a styling pass can swap them
 * (together with the theme's color tokens) without touching the components.
 */
export interface Glyphs {
  /**
   * List bullets by nesting depth; deeper levels repeat the last one. ▸, not ▪: ▪ has an emoji
   * form, drawn two cells wide by terminals whose font lacks it.
   */
  bullets: string[]
  /**
   * Task list items: `- [ ]` and `- [x]`. Plain text, not ☐/☑: Windows Terminal draws ☑ as a
   * two-cell emoji, which ran into the text after it.
   */
  taskOpen: string
  taskDone: string
  /** Drawn left of each blockquote row, once per nesting level. */
  quoteBar: string
  /** Repeated across the row for a horizontal rule. */
  rule: string
  /** Code block frame: the row with the language label, each code row, and the closing row. */
  codeTop: string
  codeSide: string
  codeBottom: string
  /** Table column separator, the rule under the header, and where the two cross. */
  tableColumn: string
  tableRule: string
  tableCross: string
  /**
   * In front of an image's alt text where the image itself is not shown. 🖼 has no emoji
   * presentation of its own, so it measures one cell, but Windows Terminal draws it as a
   * two-cell emoji over the next character: it asks for the emoji presentation (U+FE0F),
   * which measures two cells.
   */
  image: string
}

export const defaultGlyphs: Glyphs = {
  bullets: ["•", "◦", "▸"],
  taskOpen: "[ ]",
  taskDone: "[✓]",
  quoteBar: "▎",
  rule: "─",
  codeTop: "╭─",
  codeSide: "│",
  codeBottom: "╰─",
  tableColumn: "│",
  tableRule: "─",
  tableCross: "┼",
  image: "🖼\uFE0F",
}
