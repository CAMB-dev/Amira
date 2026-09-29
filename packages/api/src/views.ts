import type { ToolLine } from "./tool-renderers.ts"

/**
 * Experimental: full-screen views extensions add to frontends, such as a workflow's progress
 * tree or a swarm's timeline. An extension registers a view kind (ExtensionAPI.registerView)
 * and a command opens it with data of its own (CommandContext.openView). The frontend owns
 * the screen, scrolling and the keys to leave; the view only turns the data into lines, which
 * describe what they are rather than how they look (as tool presenters do).
 */

/** A line of a view: plain text, styled by the frontend after its kind. */
export type ViewLine = ToolLine

export interface ViewRenderOptions {
  /**
   * Columns available for each line. Longer text lines (text, muted, accent, success, warning,
   * error) wrap, their later rows hanging under the text after any leading marker; code and
   * diff lines are cut.
   */
  width: number
  /** The current time, in ms since the epoch, for elapsed times. */
  now: number
}

/** What a view's key handler can do to the open view. */
export interface ViewControl {
  /** Closes the view, back to where the user was. */
  close(): void
  /** Redraws it, e.g. after the handler changed the data. */
  requestRender(): void
  /**
   * Asks the user for one line of text at the bottom of the view, e.g. a message for an agent
   * the view shows: Enter answers, Esc cancels. Resolves with the text as typed (trimmed), or
   * undefined when cancelled or left empty. Asking again while one is open cancels that one.
   */
  prompt(title: string, opts?: { initial?: string }): Promise<string | undefined>
  /**
   * Asks the user to confirm something at the bottom of the view, the way the frontend's own
   * views do before they stop something: "Stop the run? y stops it · any other key keeps it
   * running". Resolves true only for y; any other key (or the view closing) is no. `yes` and
   * `no` say what each answer does (default "yes" and "cancels"). Asking again while one is
   * open answers that one no.
   */
  confirm(question: string, opts?: { yes?: string; no?: string }): Promise<boolean>
}

/**
 * A key the view handles, shown in its footer, e.g. `{ key: "x", label: "stop" }`. While a
 * prompt (ViewControl.prompt) is open, keys go to it instead.
 */
export interface ViewKey<D = unknown> {
  /** One printable character. Esc, q and the scrolling keys are the frontend's. */
  key: string
  label: string
  run(data: D, view: ViewControl): void
}

export interface ViewDefinition<D = any> {
  /** The name commands open it by. "subagent" is the frontend's own and cannot be taken. */
  kind: string
  /** The first line of the screen. */
  title(data: D): string
  /** Lines under the title that stay in place while the body scrolls, e.g. totals. */
  header?(data: D, opts: ViewRenderOptions): ViewLine[]
  /** The body, scrolled by the frontend. Called again whenever the view is redrawn. */
  render(data: D, opts: ViewRenderOptions): ViewLine[]
  keys?: ViewKey<D>[]
  /**
   * Whether the body keeps to its end as it grows, like a log (the default), or starts at
   * its top, like a tree whose rows change in place.
   */
  follow?: boolean
}
