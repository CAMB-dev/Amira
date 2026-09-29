import type { AnyEvent, Message, ToolDetailLevel, ToolResult, TuiSettings, UserMessage } from "@amira/api"
import type {
  Capabilities,
  Component,
  ImageLoader,
  InputEvent,
  RenderContext,
  Spinner,
  Terminal,
  Theme,
} from "@amira/tui-kit"
import type { Keybindings } from "./keybindings.ts"
import type { TrackedCall } from "./tool-calls.ts"
import type { PresenterSource } from "./tool-view.ts"
import type { NoticeLevel } from "./transcript.ts"

/** A component that draws a function's lines; handy for small pieces of view state. */
export class View implements Component {
  constructor(private draw: (width: number, ctx: RenderContext) => string[]) {}
  render(width: number, ctx: RenderContext): string[] {
    return this.draw(width, ctx)
  }
}

/** How a tool call ended, as the controller hands it over. */
export type CallEnd = NonNullable<TrackedCall["end"]>

/** A tool call a reply asked for. */
export interface CallRef {
  id: string
  name: string
  args: Record<string, unknown>
}

/** The session a resumed history belongs to, for the separator after it. */
export interface HistorySession {
  id: string
  updatedAt?: number
}

/** What the controller shares with the view that draws the conversation. */
export interface ViewHost {
  terminal: Terminal
  theme: Theme
  capabilities: Capabilities
  settings: TuiSettings
  presenters: PresenterSource | undefined
  /** Links in replies are clickable (OSC 8). */
  hyperlinks: boolean
  /**
   * Loads the images of replies where the terminal can draw them (D83): the inline view commits
   * them to the scrollback, the full-screen view draws them in its transcript. Full-screen
   * overlays (forms, the sub-agent viewer) show their alt text.
   */
  images?: ImageLoader
  keys: Keybindings
  /** The spinner of the running turn; running tools show its glyph. */
  spinner: Spinner
  /** The session the UI follows now. */
  sessionId(): string
  /** How much of finished tool calls is shown. */
  detail(): ToolDetailLevel
  /**
   * The area under the transcript: the activity line, pending messages, the input box (or the
   * dialog in its place), the lists below it or the status bar, and the key hints. `top` goes
   * first. A dialog gets what the rest leaves of `budget` rows.
   */
  bottom(width: number, ctx: RenderContext, budget: number, top?: Component): string[]
  /** The full-screen view open over the conversation: a form or the sub-agent viewer. */
  overlay: Component
  /** Whether the input box is empty. */
  editorEmpty(): boolean
  /** Shows a short note in place of the key hints for a few seconds. */
  showNote(text: string): void
}

/**
 * Draws the conversation: inline (finished blocks go to the terminal's scrollback) or full
 * screen (the whole conversation is kept and redrawn). The controller turns bus events and
 * keys into these calls; everything else (the input, dialogs, the queue) it keeps itself.
 */
export interface TranscriptView {
  /** The names of the tool calls running now, in call order, for the activity line. */
  readonly runningTools: string[]
  /** Draws the first frame, with what was added before it. */
  start(): void
  requestRender(): void
  /** Draws now; e.g. before a tool may block the event loop. */
  render(): void
  /** Clears the screen and draws it again (Ctrl+L). */
  redraw(): void
  /** Shows the overlay (a form, the viewer) over the whole screen, until `closeOverlay`. */
  openOverlay(): void
  closeOverlay(): void
  requestOverlayRender(): void
  /** Clears the screen and draws the overlay again (Ctrl+L over a form or a viewer). */
  redrawOverlay(): void
  renderOverlay(): void
  /** Leaves the terminal with the conversation in its normal screen; the UI is quitting. */
  stop(): void

  banner(line: string): void
  user(message: UserMessage): void
  replyDelta(text: string): void
  /** The reply ended and asked for these tool calls; true when it showed anything. */
  replyEnd(calls: CallRef[]): boolean
  toolStart(id: string, name: string, args: Record<string, unknown>, at: number): void
  toolUpdate(id: string, partial: ToolResult): void
  /** True when a call reached the transcript. */
  toolEnd(id: string, end: CallEnd): boolean
  /** The turn ended: calls still held are shown; true when one was. */
  turnEnd(): boolean
  /** Follows sub-agents; true when the event was about one. */
  subagentEvent(e: AnyEvent): boolean
  notice(level: NoticeLevel, text: string): void
  /** A slash command as typed. */
  commandEcho(line: string): void
  /** What a command printed: under its echo right after it, else as a notice. */
  commandOutput(level: "info" | "warning" | "error", text: string): void
  /** A dialog's questions and answers, once answered, drawn to fit a width. */
  dialogEcho(draw: (width: number) => string[]): void
  /** A resumed conversation, then a separator naming the session. */
  history(messages: Message[], session: HistorySession): void
  /** The UI is about to follow another session: calls of this one end here. */
  leaveSession(): void
  /** The note shown when the tool output level changes. */
  detailNote(level: ToolDetailLevel): string
  /** Keys the view takes before the input (scrolling, find, selecting); true when taken. */
  handleInput(e: InputEvent): boolean
  /**
   * Whether the view holds the keyboard now (a find bar, a block selection): then keys go to
   * `handleInput` first, after an open dialog.
   */
  readonly capturing: boolean
  /**
   * A key the view takes before everything but a dialog: Esc while text is selected with the
   * mouse, which clears it. True when taken.
   */
  takeFirst?(e: InputEvent): boolean
}
