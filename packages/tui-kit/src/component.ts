import type { InputEvent } from "./keys.ts"

/** Anything that can draw itself as lines for a given width. */
export interface Component {
  render(width: number): string[]
  /** Returns true when the event was handled. */
  handleInput?(event: InputEvent): boolean
}

/**
 * Zero-width marker a focused component puts where the terminal cursor belongs (an editor caret).
 * The renderer removes it and places the real cursor there.
 */
export const CURSOR_MARKER = "\x1b_tk:cursor\x07"
