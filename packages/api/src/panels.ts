import type { AgentStatusState, ThemeGlyphs } from "./themes.ts"
import type { ToolLine } from "./tool-renderers.ts"
import type { SessionData } from "./tools.ts"
import type { ViewSegment } from "./views.ts"

/**
 * Experimental: live panels, a few lines an extension keeps on screen while the user works,
 * such as a todo list. Frontends that have them (the fullscreen TUI does)
 * show every visible panel above the activity line and draw them again at each redraw, so an
 * extension changes a panel by changing its state and calling ExtensionAPI.requestRender. Lines
 * describe what they are, as a view's do; the frontend styles them.
 */

/** A panel row: a styled line, or independently styled parts on one row (cut to the width). */
export type PanelLine = ToolLine | { kind: "segments"; parts: ViewSegment[] }

export interface PanelRenderOptions {
  /** Columns available for each line; longer lines are cut. */
  width: number
  /** The current time, in ms since the epoch, for elapsed times. */
  now: number
  /** The frontend's current command spinner frame; empty when no command is animating. */
  spinner?: string
  /**
   * The shared status badge (symbol and label, host glyphs, semantic color), as in agent trees
   * and pickers; a working badge spins and keeps the panel redrawing while it is shown. Set pad
   * to true to right-pad labels to a common width. Unset where the frontend has none.
   */
  statusBadge?: (state: AgentStatusState, options?: { pad?: boolean }) => ViewSegment[]
  /**
   * Host symbols for text the panel composes: the separator between fields, and the marker
   * for cut text (three periods in ASCII glyph sets). Unset where the frontend has none.
   */
  glyphs?: Readonly<Pick<ThemeGlyphs, "separator" | "more">>
  /** The session the frontend shows now; it changes with /clear, /resume and the like. */
  sessionId: string
  /**
   * That session's extension records (SessionData), e.g. to show what a resumed session
   * recorded before any tool of the extension ran in it. Unset where the host has none.
   */
  data?: SessionData
  /**
   * The user folded the panels (the TUI toggles this with a key): a panel then shows at most
   * one line, its first. Return a summary first to make that line count.
   */
  collapsed: boolean
}

export interface PanelDefinition {
  id: string
  /** Lower comes first, higher is nearer the activity line. Default 0. */
  order?: number
  /** Must be true to replace a panel with the same id registered earlier. */
  override?: boolean
  /**
   * The lines to show now; none hides the panel. Called at every redraw, so keep it cheap.
   * Frontends show at most PANEL_MAX_LINES lines of a panel, and none of one that throws.
   */
  render(opts: PanelRenderOptions): PanelLine[]
}

/** The most lines a frontend shows of one panel; the last one says how many were left out. */
export const PANEL_MAX_LINES = 12
