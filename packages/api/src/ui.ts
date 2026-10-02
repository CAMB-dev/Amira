import type { FormSchema, FormSpec, FormValues } from "./form.ts"
import type { ToolLine } from "./tool-renderers.ts"

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
  /**
   * A choice among `options`. `sections` split the list into parts with a heading each and
   * keys of their own besides Enter; a key answers with `{ option, key }` (SelectChoice) on
   * the option it was pressed on. Clients that do not know sections answer with the option.
   * `descriptions` go with the options of the same index, in muted text ("" for none).
   */
  | {
      kind: "select"
      title: string
      options: string[]
      /** Option to highlight initially; absent or unknown starts at the first option. */
      initial?: string
      sections?: SelectSection[]
      descriptions?: string[]
      /** Full conversation text: substring filtering and matching snippets; section keys use Ctrl. */
      searchTexts?: string[]
    }
  /**
   * A yes/no question. `always` offers "Yes, and don't ask again this session" as well
   * (answered with "always"); a string says what that covers instead of "this session", e.g.
   * "this session for bash (policy)", so the user knows how far it reaches. `other` offers a
   * free-text choice (answered with `{ other: text }`) meaning no, and what to do instead. A
   * client that knows neither may still answer a boolean. `preview` shows what is asked
   * about as a tool presents it (a command, a diff), under the message.
   */
  | {
      kind: "confirm"
      title: string
      message?: string
      always?: boolean | string
      other?: boolean
      preview?: ToolLine[]
    }
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

/**
 * A part of a select's list: the options from index `at` up to the next section. `title` is
 * a heading shown above them (while nothing is typed to filter the list), `choose` says what
 * Enter does on them ("open"; default "choose"), and `keys` answer on them too.
 */
export interface SelectSection {
  at: number
  title?: string
  choose?: string
  keys?: SelectKey[]
}

/** A key that answers a select on the highlighted option, e.g. `{ key: "p", label: "print" }`. */
export interface SelectKey {
  /** One printable character, not a digit (digits pick options). */
  key: string
  label: string
}

/** The section option `index` is in: the last one starting at or before it. */
export function sectionOf(
  sections: readonly SelectSection[] | undefined,
  index: number,
): SelectSection | undefined {
  return sections?.findLast((s) => s.at <= index)
}

/** How a select with sections was answered: the option, and the key pressed on it if not Enter. */
export interface SelectChoice {
  option: string
  key?: string
}

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
  /** The option; a select with sections is answered with a SelectChoice when a key chose it. */
  select: string | SelectChoice
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
  select(
    title: string,
    options: string[],
    opts?: UiRequestOptions & { initial?: string },
  ): Promise<string | undefined>
  /**
   * A select whose list is split into sections (headings, and keys besides Enter for each);
   * resolves with the option chosen and the key that chose it (none for Enter). Frontends
   * without sections answer with Enter only. Options must differ (they are told apart by their
   * label) and sections must be well formed (see SelectSection, SelectKey), or it throws.
   */
  choose(
    title: string,
    options: string[],
    opts: UiRequestOptions & { sections: SelectSection[]; descriptions?: string[]; searchTexts?: string[] },
  ): Promise<SelectChoice | undefined>
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
