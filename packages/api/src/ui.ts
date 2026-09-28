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
  /** Must be true to replace an item with the same id registered earlier (e.g. a built-in one). */
  override?: boolean
  /** Returning undefined or "" hides the item. */
  text(): string | undefined
}

/**
 * A dialog that asks the user something (D42). The TUI shows it inline, print mode cancels
 * it, and headless clients answer it with ui.respond.
 */
export type UiRequest =
  | { kind: "select"; title: string; options: string[] }
  | { kind: "confirm"; title: string; message?: string }
  | { kind: "input"; title: string; placeholder?: string; initial?: string }

export type UiRequestKind = UiRequest["kind"]

/** The value each kind of dialog resolves with when answered. */
export interface UiAnswer {
  select: string
  confirm: boolean
  input: string
}

export interface UiRequestOptions {
  /** Cancels the dialog, e.g. a tool's abort signal. */
  signal?: AbortSignal
  /** Cancels the dialog after this long. Default: waits until answered. */
  timeoutMs?: number
}

/** Dialogs for extensions. Every method resolves; a cancelled dialog gives undefined (false for confirm). */
export interface UiApi {
  select(title: string, options: string[], opts?: UiRequestOptions): Promise<string | undefined>
  confirm(title: string, message?: string, opts?: UiRequestOptions): Promise<boolean>
  input(
    title: string,
    opts?: UiRequestOptions & { placeholder?: string; initial?: string },
  ): Promise<string | undefined>
}
