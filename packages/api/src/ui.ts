/** Semantic color for status text; frontends map it to their theme. */
export type StatusTone = "default" | "muted" | "accent" | "success" | "warning" | "error"

/**
 * One item in the status bar. Frontends read `text()` whenever they redraw,
 * so items keep their own state (usually updated from events) and stay frontend-agnostic.
 */
export interface StatusItem {
  id: string
  align?: "left" | "right"
  /** Lower comes first within its side. Default 0. */
  order?: number
  tone?: StatusTone
  /** Returning undefined or "" hides the item. */
  text(): string | undefined
}
