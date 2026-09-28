import type { InputEvent } from "./keys.ts"
import type { Theme } from "./style.ts"

/** What a component needs to know to draw itself, handed down on every render. */
export interface RenderContext {
  theme: Theme
  /**
   * Whether colors reach the terminal. When false the renderer strips them, so components need
   * not check it; it is here for components that want another cue (bold, inverse) instead.
   */
  color: boolean
}

/** Anything that can draw itself as lines for a given width. */
export interface Component {
  render(width: number, ctx: RenderContext): string[]
  /** Returns true when the event was handled. */
  handleInput?(event: InputEvent): boolean
}

/**
 * Zero-width marker a focused component puts where the terminal cursor belongs (an editor caret).
 * The renderer removes it and places the real cursor there.
 */
export const CURSOR_MARKER = "\x1b_tk:cursor\x07"
