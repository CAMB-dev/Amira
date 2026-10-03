import type { CommandOutputLevel } from "./commands.ts"
import type { ToolCallView, ToolDetailLevel, ToolLine } from "./tool-renderers.ts"
import type { UiContext, UiControl, UiEvent, UiNode } from "./views-ui.ts"

/**
 * Experimental: full-screen views extensions add to frontends, such as a workflow's progress
 * tree or a swarm's timeline. An extension registers a view kind (ExtensionAPI.registerView)
 * and a command opens it with data of its own (CommandContext.openView). The frontend owns
 * the screen, scrolling and the keys to leave; the view only turns the data into lines, which
 * describe what they are rather than how they look (as tool presenters do).
 */

/** A piece of a line, styled by meaning rather than by a frontend-specific color. */
export interface ViewSegment {
  text: string
  kind: "text" | "muted" | "accent" | "success" | "warning" | "error"
}

/** Lines styled by the frontend; text and parts contain no raw styling. */
export type ViewLine =
  | ToolLine
  /** A single row with independently styled parts, cut to the available width. */
  | { kind: "segments"; parts: ViewSegment[] }
  /** A user message, with the transcript's marker, wrapping and background band. */
  | { kind: "user-message"; text: string; note?: string }

export interface ViewRenderOptions {
  /**
   * Columns available for each line. Longer text lines (text, muted, accent, success, warning,
   * error) wrap, their later rows hanging under the text after any leading marker; code and
   * diff and segments lines are cut. User-message lines wrap like transcript user messages.
   */
  width: number
  /** The current time, in ms since the epoch, for elapsed times. */
  now: number
  /** Presents a finished tool call with the host's current presenter and fallback renderer. */
  renderTool?: (toolName: string, call: ToolCallView, detail: ToolDetailLevel) => ViewLine[]
}

/** What a view's key handler can do to the open view. */
export interface ViewControl {
  /** Closes the view, back to where the user was. */
  close(): void
  /** Redraws it, e.g. after the handler changed the data. */
  requestRender(): void
  /** Prints into the conversation, at the same levels as CommandContext.print. */
  print(text: string, level?: CommandOutputLevel): void
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
 * A key the view handles, shown in its footer, e.g. `{ key: "x", label: "stop" }`. Keys with
 * the same label share one footer item ("←→ switch"); an empty label keeps a key out of the
 * footer, e.g. an alias of another key. While a prompt (ViewControl.prompt) is open, keys go
 * to it instead.
 */
export interface ViewKey<D = unknown> {
  /** One printable character or a named navigation key. Esc, q and scrolling remain host-owned. */
  key: ViewKeyName
  label: string
  /** Legacy line-view handler. Experimental ui views declare keys here and use onEvent instead. */
  run?(data: D, view: ViewControl): void
}

export type ViewKeyName = "left" | "right" | "tab" | "shift-tab" | (string & {})

export interface ViewDefinition<D = any> {
  /** The name commands open it by. */
  kind: string
  /**
   * The first line of the screen; `opts` gives the time for an elapsed time shown there.
   * A string gets the frontend's default marker. A semantic line supplies the whole title,
   * without an added marker; it is cut to the available title space rather than wrapped.
   */
  title(data: D, opts: ViewRenderOptions): string | ViewLine
  /**
   * Short text at the right end of the title line, such as "2 of 5". It stays whole while
   * the title is cut on a narrow screen.
   */
  titleAside?(data: D): string
  /** Lines under the title that stay in place while the body scrolls, e.g. totals. */
  header?(data: D, opts: ViewRenderOptions): ViewLine[]
  /** The body, scrolled by the frontend. Called again whenever the view is redrawn. */
  render?(data: D, opts: ViewRenderOptions): ViewLine[]
  /**
   * Experimental D104 L3: replaces title/header/render screen content with semantic widgets.
   * Title remains required for window/fallback presentation. Supply ui or render. Existing
   * line-only views are unchanged. Esc and Ctrl+C always close, and so does q unless a UI input
   * has focus (it types q); ViewControl.prompt temporarily takes all of those keys. Tab moves focus, arrows operate
   * the focused widget, Enter activates/submits, and the wheel scrolls under the pointer.
   * Keep ui free of side effects: state reconciliation can rebuild it within the same frame.
   */
  ui?(data: D, ctx: UiContext): UiNode
  /** Experimental semantic events; host state changes first, then this handler may override it. */
  onEvent?(event: UiEvent, data: D, view: UiControl): void
  keys?: ViewKey<D>[]
  /**
   * Whether the body keeps to its end as it grows, like a log (the default), or starts at
   * its top, like a tree whose rows change in place.
   */
  follow?: boolean
  /**
   * Identifies the body's scroll state, e.g. the selected child or tab. Each key keeps its
   * position and following state until the view closes; omitting this uses one shared state.
   */
  scrollKey?(data: D): string
}
