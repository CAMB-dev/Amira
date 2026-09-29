import type { ImagePlacement } from "./images/screen.ts"
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
  /**
   * Height of the terminal in rows. The live region never shows more than this many lines (the
   * top ones are cut), so a tall component can use it to decide what to leave out.
   */
  rows: number
  /**
   * Moves lines into the scrollback from within a frame: they are printed above the live region
   * in the frame being drawn, before it. For content that no longer fits but will never change,
   * such as the finished rows of a streaming reply. Only the renderer's own frames provide it.
   */
  commit?: (lines: string[]) => void
  /**
   * Shows an image over the frame's rows (the full-screen renderer's frames provide it): its row
   * is the index of the line in what the root component returns. The rows under it should be
   * blank; it is drawn once and left alone while the frame keeps placing it in the same place.
   */
  place?: (placement: ImagePlacement) => void
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
