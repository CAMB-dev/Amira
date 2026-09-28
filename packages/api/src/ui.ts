import type { FormSchema, FormSpec, FormValues } from "./form.ts"

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
  /** `secret` masks what is typed; the answer is never echoed, persisted or sent in ui.resolved. */
  | { kind: "input"; title: string; placeholder?: string; initial?: string; secret?: boolean }
  /** A unified diff to look over, answered with one of `options` (D16, D38). */
  | { kind: "diff-review"; title: string; diff: string; options: string[] }
  /**
   * A whole form (see FormSpec), answered with the values by field id. Actions run on the
   * host (rpc: ui.action); the answer is checked there and refused with the problems.
   */
  | ({ kind: "form" } & FormSchema)

export type UiRequestKind = UiRequest["kind"]

/** The value each kind of dialog resolves with when answered. */
export interface UiAnswer {
  select: string
  confirm: boolean
  input: string
  "diff-review": string
  form: FormValues
}

export interface UiRequestOptions {
  /** Cancels the dialog, e.g. a tool's abort signal. */
  signal?: AbortSignal
  /** Cancels the dialog after this long. Default: waits until answered. */
  timeoutMs?: number
}

/**
 * Dialogs for extensions. Every method resolves; a dialog nobody answered (dismissed, timed
 * out, aborted, or no frontend can ask, as in print mode) gives undefined. For confirm that
 * keeps "the user said no" (false) apart from "nobody answered" (undefined).
 */
export interface UiApi {
  select(title: string, options: string[], opts?: UiRequestOptions): Promise<string | undefined>
  confirm(title: string, message?: string, opts?: UiRequestOptions): Promise<boolean | undefined>
  input(
    title: string,
    opts?: UiRequestOptions & { placeholder?: string; initial?: string; secret?: boolean },
  ): Promise<string | undefined>
  /** Shows a diff and asks what to do with it; resolves with the chosen option. */
  reviewDiff(
    title: string,
    diff: string,
    options: string[],
    opts?: UiRequestOptions,
  ): Promise<string | undefined>
  /**
   * Shows a form and resolves with its values (hidden fields left out), or undefined when
   * cancelled. The TUI shows it full screen; rpc clients get its schema; where forms are not
   * available it is asked one field at a time (runFormDialogs).
   */
  form(spec: FormSpec, opts?: UiRequestOptions): Promise<FormValues | undefined>
}
