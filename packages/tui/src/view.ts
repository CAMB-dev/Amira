import type {
  AnyEvent,
  AssistantMessage,
  CompactionInfo,
  Message,
  PrintOptions,
  ToolApproval,
  ToolDetailLevel,
  ToolRejection,
  ToolResult,
  TuiSettings,
  UserMessage,
} from "@amira/api"
import type {
  Capabilities,
  Component,
  Glyphs,
  ImageStore,
  InputEvent,
  RenderContext,
  Spinner,
  Terminal,
  Theme,
} from "@amira/tui-kit"
import { truncateToWidth } from "@amira/tui-kit"
import type { DisplayHistory } from "./display-history.ts"
import type { SessionBoundary } from "./history.ts"
import type { Keybindings } from "./keybindings.ts"
import type { ReplyRenderers } from "./markdown-nodes.ts"
import type { PresenterSource } from "./tool-view.ts"
import type { NoticeLevel } from "./transcript.ts"

/** A component that draws a function's lines; handy for small pieces of view state. */
export class View implements Component {
  constructor(private draw: (width: number, ctx: RenderContext) => string[]) {}
  render(width: number, ctx: RenderContext): string[] {
    return this.draw(width, ctx)
  }
}

/** Focus labels are presentation chrome, never session identifiers. */
export function activationBoundary(label: string, width: number, theme: Theme): string[] {
  return [theme.muted(truncateToWidth(label.replace(/\p{Cc}/gu, " "), Math.max(1, width), ""))]
}

/** How a tool call ended, as the controller hands it over. */
export interface CallEnd {
  result: ToolResult
  durationMs: number
  rejected?: ToolRejection
  /** The user had interrupted the turn when it ended. */
  interrupted?: boolean
  /** Who let it run, when it needed approval. */
  approval?: ToolApproval
}

/** A tool call a reply asked for. */
export interface CallRef {
  id: string
  name: string
  args: Record<string, unknown>
}

/** What the controller shares with the view that draws the conversation. */
export interface ViewHost {
  terminal: Terminal
  theme: Theme
  glyphs?: Glyphs
  capabilities: Capabilities
  settings: TuiSettings
  presenters: PresenterSource | undefined
  /** Links in replies are clickable (OSC 8). */
  hyperlinks: boolean
  /**
   * Loads the images of replies where the terminal can draw them in the transcript (D83). Full-screen
   * overlays (forms, the sub-agent viewer) show their alt text. Asked each time: undefined while
   * no image provider is installed (D88).
   */
  images?: () => ImageStore | undefined
  /** Nodes of replies that extensions render (D88). */
  renders: ReplyRenderers
  keys: Keybindings
  /** The spinner of the running turn; running tools show its glyph. */
  spinner: Spinner
  /** The session the UI follows now. */
  sessionId(): string
  /** How much of finished tool calls is shown. */
  detail(): ToolDetailLevel
  /**
   * The area under the transcript: the activity line, pending messages, the input box (or the
   * dialog in its place), the lists below it or the status bar, and the key hints.
   * A dialog gets what the rest leaves of `budget` rows.
   */
  bottom(width: number, ctx: RenderContext, budget: number): string[]
  /** The fixed header above the transcript. */
  header?(width: number, ctx: RenderContext): string[]
  /** The full-screen view open over the conversation: a form or the sub-agent viewer. */
  overlay: Component
  /** Whether the input box is empty. */
  editorEmpty(): boolean
  /** Shows a short note in place of the key hints for a few seconds. */
  showNote(text: string): void
  /** Opens the sub-agent viewer on one; unset where there is none (no commands). */
  openSubagent?(id: string): void
}

/**
 * Draws the conversation full screen, keeping and redrawing its blocks. The controller turns
 * bus events and keys into these calls; everything else (the input, dialogs, the queue) it keeps itself.
 */
export interface TranscriptView {
  /** The names of the tool calls running now, in call order, for the activity line. */
  readonly runningTools: string[]
  /** Draws the first frame, with what was added before it. */
  start(): void
  /** Stages named destination chrome before start() or a retained setVisible(true), without replay. */
  activate(boundary: string): void
  /** Retains the conversation while hidden; only the visible view draws or ticks sub-agents. */
  setVisible(visible: boolean): void
  requestRender(): void
  /** Replaces render styles and glyphs, invalidates cached rows, and repaints the active screen. */
  setTheme(theme: Theme, glyphs: Glyphs): void
  /** Draws now; e.g. before a tool may block the event loop. */
  render(): void
  /** Clears the screen and draws it again (Ctrl+L). */
  redraw(): void
  /** Shows the overlay (a form, the viewer) over the whole screen, until `closeOverlay`. */
  openOverlay(pointer?: boolean): void
  closeOverlay(): void
  requestOverlayRender(): void
  /** Clears the screen and draws the overlay again (Ctrl+L over a form or a viewer). */
  redrawOverlay(): void
  renderOverlay(): void
  /** Leaves the terminal with the conversation in its normal screen; the UI is quitting. */
  stop(): void

  banner(line: string | ((theme: Theme) => string)): void
  user(message: UserMessage): void
  replyDelta(text: string): void
  /**
   * The reply's reasoning streamed in (a thinking delta): it shows as "∴ Thought for 12s" once
   * the reply goes on, and counts as something the reply showed.
   */
  reasoningDelta(text: string): void
  /** Repairs an incomplete live reply from its authoritative final content, when editable. */
  replaceReply?(content: AssistantMessage["content"]): boolean
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
  /** `detail` stays folded until asked for (the full tool output level, or unfolding the block). */
  notice(level: NoticeLevel, text: string, detail?: string): void
  /** A slash command as typed. */
  commandEcho(line: string): void
  /** What a command printed: under its echo right after it, else as a notice. */
  commandOutput(level: "info" | "warning" | "error", text: string): void
  /** Foldable, display-only extension output. */
  display(level: NoticeLevel, text: string, options?: PrintOptions): void
  /** A dialog's questions and answers, once answered, drawn to fit a width. */
  dialogEcho(draw: (width: number) => string[]): void
  /**
   * The UI follows a session from here: a boundary naming it, then its conversation so far.
   * `switched` (a command switched sessions: /clear, /resume): the transcript starts afresh
   * first (the banner stays), so finding, copying, selecting and the exit printout see this
   * session only.
   */
  openSession(
    boundary: SessionBoundary,
    messages: Message[],
    switched: boolean,
    /** Why each compaction happened, by its summary's user message (Agent.compactionInfo). */
    compactionInfo?: (message: Message) => CompactionInfo | undefined,
    displays?: readonly DisplayHistory[],
  ): void
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
