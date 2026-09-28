/**
 * The characters the input features draw with (history search, completion lists), kept in one
 * place so a styling pass can swap them together with the theme's color tokens.
 */
export const inputGlyphs = {
  /** In front of the selected row of a completion list. */
  pointer: "›",
  /** Starts the history search line. */
  search: "⌕",
  /** Between the search line's label and the query. */
  searchPrompt: "›",
}
