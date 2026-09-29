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
  /**
   * Lower comes first within its side. Default 0; the built-in items use negative orders, so
   * other items follow them: on the right side, between the built-in ones and the edge.
   */
  order?: number
  /**
   * How much the item matters when the bar is too narrow for all of them: the lowest goes
   * first (of equals, the later one). Default 0; the built-in items use 10 to 40, so other
   * items give way first.
   */
  priority?: number
  /** A fixed tone, or one read at each redraw, e.g. a warning as a limit nears. */
  tone?: StatusTone | (() => StatusTone | undefined)
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
  /**
   * A yes/no question. `always` offers "Yes, and don't ask again this session" as well
   * (answered with "always"); a string says what that covers instead of "this session", e.g.
   * "this session for bash (policy)", so the user knows how far it reaches. `other` offers a
   * free-text choice (answered with `{ other: text }`) meaning no, and what to do instead. A
   * client that knows neither may still answer a boolean.
   */
  | { kind: "confirm"; title: string; message?: string; always?: boolean | string; other?: boolean }
  /** `secret` masks what is typed; the answer is never echoed, persisted or sent in ui.resolved. */
  | { kind: "input"; title: string; placeholder?: string; initial?: string; secret?: boolean }
  /** A unified diff to look over, answered with one of `options` (D16, D38). */
  | { kind: "diff-review"; title: string; diff: string; options: string[] }
  /**
   * One to four questions with a few options each, as the ask_user tool asks them, answered
   * together with one AskAnswer per question, in order. Every question also takes free text
   * ("Other"). `title` names the whole request (the first question, or how many there are).
   */
  | { kind: "ask"; title: string; questions: AskQuestion[] }
  /**
   * A whole form (see FormSpec), answered with the values by field id. Actions run on the
   * host (rpc: ui.action); the answer is checked there and refused with the problems.
   */
  | ({ kind: "form" } & FormSchema)

export type UiRequestKind = UiRequest["kind"]

export interface AskOption {
  label: string
  /** What choosing it means, shown next to the label. */
  description?: string
}

export interface AskQuestion {
  question: string
  /** A short name for the question (at most 12 characters), shown when there are several. */
  header?: string
  /** Two to four; the free-text "Other" choice is added by the frontend. */
  options: AskOption[]
  /** Several options may be chosen together. */
  multiSelect?: boolean
}

/**
 * The answer to one AskQuestion: the labels chosen (exactly one for a single-choice question
 * unless `other` is given; any number for a multi-select one), and the text typed in "Other".
 */
export interface AskAnswer {
  selected: string[]
  other?: string
}

/**
 * How questions a session put (ToolSession.askUser) ended: answered (`by` names who answered
 * when it was not the user, such as the commander of a sub-agent), declined (cancelled), or
 * never asked because nobody can answer here (print mode).
 */
export type AskOutcome =
  | { answers: AskAnswer[]; by?: string }
  | { declined: true; by?: string }
  | { unavailable: string }

/** A confirm's answer: yes or no, "always" (yes, for the rest of the session), or free text. */
export type ConfirmAnswer = boolean | "always" | { other: string }

/** The value each kind of dialog resolves with when answered. */
export interface UiAnswer {
  select: string
  confirm: ConfirmAnswer
  input: string
  "diff-review": string
  ask: AskAnswer[]
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
   * Asks one to four questions with a few options each, plus free text ("Other"); resolves
   * with one answer per question, in order. `title` defaults to the question when there is one, else "N questions".
   */
  ask(
    questions: AskQuestion[],
    opts?: UiRequestOptions & { title?: string },
  ): Promise<AskAnswer[] | undefined>
  /**
   * Shows a form and resolves with its values (hidden fields left out), or undefined when
   * cancelled. The TUI shows it full screen; rpc clients get its schema; where forms are not
   * available it is asked one field at a time (runFormDialogs).
   */
  form(spec: FormSpec, opts?: UiRequestOptions): Promise<FormValues | undefined>
}
