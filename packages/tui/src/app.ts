import { statSync } from "node:fs"
import {
  type AnyEvent,
  type CommandDefinition,
  type FrontendView,
  isSubagentView,
  modelLabel,
  type ToolDetailLevel,
  type TuiSettings,
  type UserMessage,
} from "@amira/api"
import {
  type Agent,
  AgentBusyError,
  type CommandHost,
  type PanelRegistry,
  parseCommandLine,
  type StatusRegistry,
  type UiRequests,
} from "@amira/core"
import {
  type Component,
  chooseImageSupport,
  colorSupported,
  defaultTheme,
  detectEnv,
  Editor,
  type EditorPart,
  ImageStore,
  type InputEvent,
  InputReader,
  isColorEnabled,
  monoTheme,
  ProcessTerminal,
  progressSupported,
  type RenderContext,
  type SetupResult,
  Spinner,
  Stack,
  setupTerminalInput,
  supportsHyperlinks,
  surfaceTheme,
  type Terminal,
  type Theme,
  truncateToWidth,
  wrapText,
} from "@amira/tui-kit"
import { CommandPopup } from "./command-popup.ts"
import { Dialog, type DialogAnswer, dialogEchoLines } from "./dialog.ts"
import { renderToolLines } from "./diff-view.ts"
import { ExtensionViewer, type ViewSource } from "./extension-view.ts"
import { FileIndex, type FileSource } from "./file-index.ts"
import { FilePicker } from "./file-picker.ts"
import { type FormRequest, FormView, uiFormBackend } from "./form-view.ts"
import { compactTokens, userLines, userText } from "./format.ts"
import { createFullscreenView } from "./fullscreen-view.ts"
import { glyphs } from "./glyphs.ts"
import { fitHint } from "./hint.ts"
import { HistorySearch } from "./history-search.ts"
import { createInlineView } from "./inline-view.ts"
import { InputBox } from "./input-box.ts"
import { KeyReference } from "./key-reference.ts"
import { defaultKeys, Keybindings, type KeySpec } from "./keybindings.ts"
import { type ImageSource, type MarkdownRenderSource, ReplyRenderers } from "./markdown-nodes.ts"
import { HistoryNavigator, PromptHistory } from "./prompt-history.ts"
import { statusLine } from "./status-bar.ts"
import { SubagentViewer } from "./subagent-view.ts"
import { TerminalStatus } from "./terminal-status.ts"
import { formatElapsed, type PresenterSource } from "./tool-view.ts"
import { INTERRUPTED_NOTICE, modelErrorNotice } from "./transcript.ts"
import { detailCommand, nextDetail } from "./verbose.ts"
import { type TranscriptView, View, type ViewHost } from "./view.ts"

export interface InteractiveOptions {
  agent: Agent
  status: StatusRegistry
  /** Live panels registered by extensions, shown above the activity line in both modes. */
  panels?: PanelRegistry
  /** Extension dialogs, answered inline. Without it they are left to other frontends. */
  ui?: UiRequests
  /**
   * Slash commands and their completion popup. It owns the active session: the UI follows
   * the agent it switches to (/clear, /resume).
   */
  commands?: CommandHost
  /**
   * Adds the TUI's own slash commands (/verbose) to the registry `commands` runs from; the
   * returned function removes them again when the UI quits.
   */
  registerCommand?: (command: CommandDefinition) => () => void
  /** Presenters of tool calls registered by extensions (D1); unknown tools use a generic one. */
  toolRenderers?: PresenterSource
  /** Full-screen view kinds registered by extensions, which commands open with openView. */
  views?: ViewSource
  /** Events emitted before the UI subscribed, such as extension load errors. */
  startupEvents?: AnyEvent[]
  /** Sent as the first message once the UI is up. */
  initialPrompt?: string
  /** Shown as a warning under the banner, e.g. that no model is selected yet. */
  notice?: string
  /** Called once the UI listens to the bus, e.g. to announce the session. */
  onReady?: () => void
  terminal?: Terminal
  /** Terminal setup; injectable for tests. Defaults to probing the real terminal. */
  setup?: (
    terminal: Terminal,
    env?: Record<string, string | undefined>,
    opts?: { images?: boolean; background?: boolean },
  ) => Promise<SetupResult>
  theme?: Theme
  /**
   * Prompts sent before, for ↑/↓ and Ctrl+R; the CLI passes the project's persisted history.
   * Default: one kept in memory for this run.
   */
  history?: PromptHistory
  /** The files the @ picker offers. Default: the working directory's, from git or a walk. */
  files?: FileSource
  /** The keys of every action; defaults to the defaults for this terminal. See loadKeybindings. */
  keybindings?: Keybindings
  /**
   * The `tui` settings: the mode, bell, title, progress indicator, reflow, what Enter does
   * while working.
   */
  settings?: TuiSettings
  /**
   * Full screen (the conversation kept on the alternate screen, scrolled by Amira) or inline
   * (finished output goes to the terminal's scrollback). Default: `settings.mode`, else inline;
   * the CLI defaults to full screen (D84).
   */
  mode?: "fullscreen" | "inline"
  /** Tells the terminal apart (Windows Terminal, VS Code); injectable for tests. */
  env?: Record<string, string | undefined>
  /** Image providers registered by extensions (D88); without one, images are their alt text. */
  imageProviders?: ImageSource
  /** Markdown renderers registered by extensions (D88), e.g. diagrams for ```mermaid blocks. */
  markdownRenderers?: MarkdownRenderSource
}

/** The renderer's shortest time between frames, and how long a key waits for async candidates. */
const FRAME_MS = 16

/** The items of a hint line, most useful ones with the highest priority. */
type HintItems = Parameters<typeof fitHint>[0]

/** Bracketed pastes this big become one placeholder in the editor, expanded when sent. */
const FOLD_PASTES = { lines: 8, chars: 1000 }

/** A message on its way: the text the model gets, and what the transcript shows when that differs. */
interface Outgoing {
  text: string
  /** The text with folded pastes as their placeholders. */
  display?: string
}

function outgoing(text: string, display: string | undefined): Outgoing {
  const shown = display?.trim()
  return shown && shown !== text ? { text, display: shown } : { text }
}

/** What to hand the agent: the text, or a message that shows its placeholders (MessageDisplay). */
function toPrompt(o: Outgoing): string | UserMessage {
  if (!o.display) return o.text
  return { role: "user", content: [{ type: "text", text: o.text }], display: { text: o.display } }
}

/** What a message sent while a turn runs does: joins that turn, or waits for the next. */
type WhileWorking = "steer" | "queue"

const otherWay = (w: WhileWorking): WhileWorking => (w === "steer" ? "queue" : "steer")

/** Events without a turn that the UI shows whatever session emitted them. */
const HOST_EVENTS = new Set<string>([
  "extension.error",
  "extension.notice",
  "ui.render",
  "extension.loaded",
  "ui.request",
  "ui.resolved",
  "command.output",
])

/** How long a note such as "Tool output: full" replaces the key hints. */
const HINT_NOTE_MS = 4000

/**
 * How a user message reads while queued, or back in the editor once dropped: its display text,
 * if any. That is what the user typed (e.g. "/review-pr 123"), so sending it again re-runs it.
 */
function messageText(m: UserMessage): string {
  return m.display?.text.trim() || userText(m)
}

/** Output tokens a streamed text is worth, until the reply's usage says. */
const estimateTokens = (chars: number) => Math.ceil(chars / 4)

/** What the turn is doing now, as the activity line names it: the most specific activity first. */
export function activityLabel(s: {
  compacting: boolean
  running: readonly string[]
  preparing: string | undefined
  thinking: boolean
}): string {
  if (s.compacting) return "compacting the conversation"
  if (s.running.length === 1) return `running ${s.running[0]}`
  if (s.running.length > 1) return `running ${s.running.length} tools`
  if (s.preparing) return `preparing ${s.preparing}`
  return s.thinking ? "thinking" : "working"
}

/**
 * The interactive terminal UI. This is its controller: it follows the bus and the keys, keeps
 * the input, dialogs, forms and the message queue, and hands the conversation to a view that
 * draws it inline (finished output goes to the scrollback) or full screen (the conversation
 * is kept and scrolled by Amira). Resolves with the process exit code when the user quits.
 */
export async function runInteractive(opts: InteractiveOptions): Promise<number> {
  let { agent } = opts
  const terminal = opts.terminal ?? new ProcessTerminal()
  const presenters = opts.toolRenderers
  const env = opts.env ?? process.env
  const settings = opts.settings ?? {}
  const imageSetting = settings.images ?? "auto"
  const { capabilities, leftoverInput } = await (opts.setup ?? setupTerminalInput)(terminal, env, {
    images: imageSetting !== "off",
    background: true,
  })
  // Surface colors (the band behind the user's messages, diff lines) for the terminal's
  // background; none without colors, where the band would only be blank rows and attributes
  // (dim, bold) tell apart what colors would.
  const theme =
    opts.theme ??
    (isColorEnabled() && colorSupported(env)
      ? { ...defaultTheme, ...surfaceTheme(capabilities.background) }
      : monoTheme)

  // Links are clickable (OSC 8) where the terminal is known to support them.
  const hyperlinks = supportsHyperlinks(env)
  // Images on a line of their own are drawn where the terminal can, in both views: at most 20
  // rows, and 40% of the screen. Full-screen overlays (the sub-agent viewer, forms) show their
  // alt text (D83, D84). What images are made of comes from image providers (the images
  // extension, D88): without one, they are their alt text.
  const imageSupport = chooseImageSupport(imageSetting, capabilities.graphics, env)
  const providers = opts.imageProviders
  const imageStore =
    imageSupport &&
    providers &&
    new ImageStore({
      support: imageSupport,
      open: (input, ctx) => providers.open(input, ctx),
      cwd: () => agent.cwd,
      maxRows: () => Math.max(1, Math.min(20, Math.floor(terminal.rows * 0.4))),
    })
  const images = imageStore ? () => (providers!.size > 0 ? imageStore : undefined) : undefined
  // Nodes of replies extensions render, e.g. ```mermaid diagrams (D88).
  const renders = new ReplyRenderers(opts.markdownRenderers)
  const spinner = new Spinner()
  const queued: Outgoing[] = []
  /** Content of recent messages with folded pastes, by their text, so a dropped steer comes back folded. */
  const sentParts = new Map<string, EditorPart[]>()
  /**
   * Queued messages sent together as the next prompt, as the transcript shows each (its display
   * text, else its text), so it can show them one by one.
   */
  let mergedQueue: string[] | undefined
  /** Messages steering the running turn that have not reached the model yet. */
  const steering: string[] = []
  /** Lines of notices (background results) waiting to reach the model. */
  const pendingNotices: string[] = []
  /** When held notices are sent again after a failed turn (notice.retry); redrawn each second. */
  let noticeRetryAt: number | undefined
  let retryTimer: ReturnType<typeof setInterval> | undefined
  const setRetry = (at: number | undefined) => {
    noticeRetryAt = at
    if (at !== undefined && !retryTimer) retryTimer = setInterval(() => view.requestRender(), 1000)
    else if (at === undefined && retryTimer) {
      clearInterval(retryTimer)
      retryTimer = undefined
    }
  }
  /** Pending notice lines, with the time to the next resend when one is due. */
  const pendingNoticeLines = (t: Theme): string[] => {
    const retry =
      noticeRetryAt === undefined
        ? ""
        : ` · retry in ${Math.max(0, Math.ceil((noticeRetryAt - Date.now()) / 1000))}s`
    const lines = pendingNotices.length
      ? pendingNotices
      : noticeRetryAt !== undefined
        ? [`${t.accent("◆")}${t.muted(" sub-agents' results")}`]
        : []
    return lines.map((l) => `${l}${t.muted(` · pending${retry}`)}`)
  }
  /** Open extension dialogs; the first one has the keyboard. */
  const dialogs: Dialog[] = []
  let working = false
  let thinking = false
  let compacting = false
  /** Tool the model is currently writing a call for, before it runs. */
  let preparing: string | undefined
  /** Whether the current turn showed anything besides the user's message. */
  let turnShowedOutput = false
  /** When the running turn started, and the output tokens its finished replies used. */
  let turnStartedAt = 0
  let turnTokens = 0
  /**
   * send() started the clock for the turn it asked for: the prompt may wait for a compaction
   * before turn.start comes, and the activity line must not show the last turn's numbers then.
   */
  let clockFromSend = false
  /** When a compaction outside a turn (/compact) started. */
  let compactStartedAt = 0
  /** Characters of the reply streaming now: its tokens until its usage arrives. */
  let streamedChars = 0
  /** The user interrupted this turn: the failures of calls it cut short are not the tools'. */
  let interrupted = false
  /** How much of each finished tool call is shown; Ctrl+O and /verbose change it. */
  let detail: ToolDetailLevel = "summary"
  /** A short note shown in place of the key hints, such as the new tool output level. */
  let hintNote: { text: string; until: number } | undefined
  let hintTimer: ReturnType<typeof setTimeout> | undefined
  const showNote = (text: string) => {
    hintNote = { text, until: Date.now() + HINT_NOTE_MS }
    clearTimeout(hintTimer)
    hintTimer = setTimeout(() => view.requestRender(), HINT_NOTE_MS + 10)
    view.requestRender()
  }

  const keys = opts.keybindings ?? new Keybindings(defaultKeys(detectEnv(env)))
  /** What Enter does with a message while a turn runs; the queue key does the other. */
  const enterDoes: WhileWorking = settings.submitWhileWorking === "queue" ? "queue" : "steer"
  const termStatus = new TerminalStatus(terminal, agent.cwd, {
    title: settings.title ?? true,
    progress: (settings.progress ?? true) && progressSupported(env),
    bell: settings.bell ?? true,
  })
  /** What the terminal last reported about its focus; unknown until it reports. */
  let focused: boolean | undefined
  const editor = new Editor({
    prompt: theme.accent("› "),
    placeholder: "Message Amira",
    onSubmit: (text, info) => submit(text, info.parts, info.display),
    foldPastes: FOLD_PASTES,
    isSubmit: (e) => keys.is(e, "submit"),
    isNewline: (e) => keys.is(e, "newline"),
  })
  const commands = opts.commands
  // The "/" popup lists commands, the "$" one skills; at most one is open, by the first character.
  const popups = commands
    ? [
        new CommandPopup(commands, () => view.requestRender(), keys),
        new CommandPopup(
          { complete: (line) => commands.completeSkill(line), list: () => commands.skills() },
          () => view.requestRender(),
          keys,
          "$",
        ),
      ]
    : []
  const openPopup = () => popups.find((p) => p.open)
  const history = opts.history ?? new PromptHistory()
  const historyNav = new HistoryNavigator(history, editor)
  const search = new HistorySearch(history, editor, keys)
  /** The project's files for the @ picker; one the UI made itself it also stops on quit. */
  const ownFiles = opts.files ? undefined : new FileIndex(agent.cwd)
  const filePicker = new FilePicker(opts.files ?? ownFiles!, () => view.requestRender(), keys)
  /**
   * Tells the completion lists what the editor holds; a promise while commands' candidates are
   * on their way. Cheap on any text: the command popup only looks at a single line, the file
   * picker at the caret's line up to the caret, and it never waits for the project's files.
   */
  const syncCompletions = (): Promise<void> | undefined => {
    const line = editor.lineCount === 1 ? editor.getText() : ""
    const commandsPending = popups.map((p) => p.update(line)).find(Boolean)
    filePicker.update(editor.textBeforeCaret())
    return commandsPending
  }
  /** The list shown below the input box, if any, with its key hint. */
  const inputList = ():
    | { lines: (width: number, ctx: RenderContext) => string[]; hint: () => HintItems }
    | undefined => {
    if (search.active) return { lines: (w, ctx) => search.render(w, ctx), hint: searchHint }
    const popup = popups.find((p) => p.visible)
    if (popup) return { lines: (w, ctx) => popup.render(w, ctx), hint: popupHint }
    if (filePicker.visible) return { lines: (w, ctx) => filePicker.render(w, ctx), hint: fileHint }
    return undefined
  }
  // Shift+Enter is no use where the terminal sends it as plain Enter.
  const reaches = (s: KeySpec) => capabilities.shiftEnter || !(s.shift && s.name === "enter")
  const newlineKey = keys.label("newline", reaches)
  const queueKey = keys.label("queue")
  const inputBox = new InputBox(editor, () => opts.status.snapshot())
  /** Rows the last frame's dialog took, to size it against the rest of the bottom area. */
  let dialogRows = 0
  /** The user folded the live panels to one line each (panels.toggle). */
  let panelsCollapsed = false
  /** Whether the last frame showed a panel: only then does the fold key act. */
  let panelsShown = false
  /** Rows the panels may take this frame, their blank line included; layoutBottom sets it. */
  let panelRoom = Number.POSITIVE_INFINITY
  /** Rows the last frame's panels took. */
  let panelRows = 0

  const panelLines = (width: number, ctx: RenderContext, collapsed: boolean) =>
    (opts.panels?.size
      ? opts.panels.snapshot({
          width,
          now: Date.now(),
          sessionId: agent.sessionId,
          data: agent.data,
          collapsed,
        })
      : []
    ).flatMap((p) => renderToolLines(p.lines, ctx.theme, width))

  const bottom = new Stack([
    // Live panels (e.g. a todo list): extensions supply the lines, for the session shown now.
    // They give way to everything else under the transcript: folded, then cut, when rows are short.
    new View((width, ctx) => {
      let lines = panelRoom < 2 ? [] : panelLines(width, ctx, panelsCollapsed)
      if (!panelsCollapsed && lines.length + 1 > panelRoom) lines = panelLines(width, ctx, true)
      if (lines.length + 1 > panelRoom) lines = lines.slice(0, Math.max(0, panelRoom - 1))
      panelsShown = lines.length > 0
      panelRows = panelsShown ? lines.length + 1 : 0
      return panelsShown ? [...lines, ""] : []
    }),
    // The activity line: what the turn is doing, how long it has run, the tokens it wrote.
    // It shows for the whole turn, also while tools run (their rows carry a spinner of their own).
    // How to interrupt is on the hint line.
    new View((width, ctx) => {
      if (!working && !compacting) return []
      const label = activityLabel({ compacting, running: view.runningTools, preparing, thinking })
      const tokens = turnTokens + estimateTokens(streamedChars)
      const stats = [
        formatElapsed(Date.now() - (working ? turnStartedAt : compactStartedAt)),
        ...(tokens ? [`↓ ${compactTokens(tokens)} tokens`] : []),
      ].join(` ${glyphs.separator} `)
      const head = `${ctx.theme.accent(spinner.glyph)} ${ctx.theme.muted(`${label} ${glyphs.separator} `)}`
      return [truncateToWidth(head + ctx.theme.muted(stats), width, glyphs.more), ""]
    }),
    new View((width, ctx) => [
      ...pendingNoticeLines(ctx.theme).map((l) => truncateToWidth(l, width, "…")),
      ...steering.flatMap((s) => wrapText(ctx.theme.muted(`steering › ${s.replace(/\s+/g, " ")}`), width)),
      ...queued.flatMap((q) =>
        wrapText(ctx.theme.muted(`queued › ${(q.display ?? q.text).replace(/\s+/g, " ")}`), width),
      ),
    ]),
    // The input box carries the status in its bottom border. A dialog takes the box's place;
    // the status then gets a line of its own under it.
    new View((width, ctx) => {
      if (!dialogs[0]) return inputBox.render(width, ctx)
      const lines = dialogs[0].render(width, ctx)
      dialogRows = lines.length
      return [...lines, ...statusLine(opts.status.snapshot(), width, ctx)]
    }),
    // The command or skill list, file list or history search opens below the input box, in place of
    // the hint, so the box stays where it is while the list changes with each key.
    new View((width, ctx) => {
      const list = dialogs[0] ? undefined : inputList()
      if (!list) return []
      return [...list.lines(width, ctx), ctx.theme.muted(fitHint(list.hint(), width))]
    }),
    // The key hint, or a note in its place. A find bar or block selection (full screen) shows
    // its own keys above the transcript: the row stays, blank, so the layout does not jump.
    new View((width, ctx) => {
      if (dialogs[0] || inputList()) return []
      if (hintNote && Date.now() < hintNote.until) {
        return [ctx.theme.muted(truncateToWidth(hintNote.text, width, glyphs.more))]
      }
      if (view.capturing) return [""]
      return [ctx.theme.muted(fitHint(inputHint(), width))]
    }),
  ])

  /**
   * The bottom area under `top`, fitted into `budget` rows: live panels give way first (to the
   * dialog at its full size too), then the dialog is fitted into what the rest leaves.
   */
  function layoutBottom(width: number, ctx: RenderContext, budget: number, top?: Component): string[] {
    const parts = top ? [top, bottom] : [bottom]
    const draw = () => parts.flatMap((c) => c.render(width, ctx))
    const dialog = dialogs[0]
    if (dialog) dialog.maxRows = Math.max(1, budget)
    panelRoom = Number.POSITIVE_INFINITY
    let rest = draw()
    if (panelRows && rest.length > budget) {
      panelRoom = Math.max(0, budget - (rest.length - panelRows))
      rest = draw()
    }
    if (dialog && rest.length > budget) {
      dialog.maxRows = Math.max(1, budget - (rest.length - dialogRows))
      rest = draw()
    }
    return rest
  }

  /**
   * The few keys that matter now, the most useful first to stay as the line narrows; the key
   * reference (the help key) lists the rest.
   */
  function inputHint(): HintItems {
    const submitKey = keys.label("submit")
    const interruptKey = keys.label("interrupt")
    if (working) {
      return [
        submitKey && { text: `${submitKey} ${enterDoes}`, priority: 5 },
        queueKey && { text: `${queueKey} ${otherWay(enterDoes)}`, priority: 3 },
        interruptKey && { text: `${interruptKey} interrupt`, priority: 4 },
      ]
    }
    const helpKey = keys.label("help")
    return [
      submitKey && { text: `${submitKey} send`, priority: 5 },
      // A /compact runs without a turn; the interrupt key stops it too.
      compacting && interruptKey && { text: `${interruptKey} interrupt`, priority: 4 },
      // The help key only works on an empty input; with text, how to break a line matters more.
      editor.isEmpty
        ? helpKey && { text: `${helpKey} keys`, priority: 3 }
        : newlineKey && { text: `${newlineKey} newline`, priority: 3 },
    ]
  }

  function searchHint(): HintItems {
    const accept = keys.label("search.accept")
    const older = keys.label("search.older")
    const cancel = keys.label("search.cancel")
    return [
      accept && { text: `${accept} accept`, priority: 5 },
      older && { text: `${older} older`, priority: 3 },
      cancel && { text: `${cancel} cancel`, priority: 4 },
    ]
  }

  /** The file list takes the command popup's keys; Tab and Enter both insert. */
  function fileHint(): HintItems {
    const insert = [keys.label("popup.complete"), keys.label("popup.accept")].filter(Boolean).join("/")
    const close = keys.label("popup.close")
    // Nothing to choose yet (the project is still listed, or the query still searched).
    if (!filePicker.open) return [close && { text: `${close} close`, priority: 4 }]
    return [
      insert && { text: `${insert} insert`, priority: 5 },
      close && { text: `${close} close`, priority: 4 },
    ]
  }

  function popupHint(): HintItems {
    const complete = keys.label("popup.complete")
    const accept = keys.label("popup.accept")
    const close = keys.label("popup.close")
    return [
      complete && { text: `${complete} complete`, priority: 2 },
      accept && { text: `${accept} run`, priority: 5 },
      close && { text: `${close} close`, priority: 4 },
    ]
  }

  /**
   * The full-screen sub-agent viewer or an extension's view, open over the conversation. Inline,
   * the UI is suspended meanwhile: what the main session commits is held and printed when it closes.
   */
  let viewer: SubagentViewer | ExtensionViewer | KeyReference | undefined
  let viewerTimer: ReturnType<typeof setInterval> | undefined
  /**
   * Forms (ui.form) waiting to be shown full screen, oldest first; the first one is open while
   * `form` is set. A form waits while an inline dialog or the viewer is up, and inline dialogs
   * that arrive while a form is open wait behind it.
   */
  const forms: FormRequest[] = []
  let form: FormView | undefined
  /** Titles of everything waiting for an answer, for the banners of full-screen views. */
  const waitingTitles = () => [
    ...dialogs.map((d) => d.request.title),
    ...forms.slice(form ? 1 : 0).map((f) => f.title),
  ]

  const host: ViewHost = {
    terminal,
    theme,
    capabilities,
    settings,
    presenters,
    hyperlinks,
    ...(images ? { images } : {}),
    renders,
    keys,
    spinner,
    sessionId: () => agent.sessionId,
    detail: () => detail,
    bottom: layoutBottom,
    overlay: new View((width, ctx) => (form ? form.render(width, ctx) : (viewer?.render(width, ctx) ?? []))),
    editorEmpty: () => editor.isEmpty,
    showNote,
  }
  // A dumb terminal has no alternate screen to draw the full-screen view on.
  const mode = env.TERM === "dumb" ? "inline" : (opts.mode ?? settings.mode ?? "inline")
  const view: TranscriptView = mode === "fullscreen" ? createFullscreenView(host) : createInlineView(host)

  function openView(v: FrontendView) {
    if (isSubagentView(v)) {
      // A form owns the screen until it is answered.
      if (!commands || form) return
      if (viewer instanceof SubagentViewer) viewer.show(v.sessionId)
      else {
        showOverlay(
          new SubagentViewer(v.sessionId, {
            source: commands.control,
            waiting: waitingTitles,
            onClose: closeView,
            ...(presenters ? { presenters } : {}),
          }),
        )
      }
      view.renderOverlay()
      return
    }
    const definition = opts.views?.get(v.kind)
    if (!definition) throw new Error(`there is no "${v.kind}" view`)
    if (form) return
    if (viewer instanceof ExtensionViewer && viewer.kind === v.kind) viewer.show(v.data)
    else {
      showOverlay(
        new ExtensionViewer(definition, v.data, {
          waiting: waitingTitles,
          onClose: closeView,
          requestRender: () => view.requestOverlayRender(),
          onError: (error) => view.notice("warning", `[view ${v.kind}] ${error}`),
        }),
      )
    }
    view.renderOverlay()
  }

  /** Opens the key reference over the conversation (the help key); a form keeps the screen. */
  function openKeyReference() {
    if (form) return
    showOverlay(
      new KeyReference(keys, {
        fullscreen: mode === "fullscreen",
        onClose: closeView,
        usable: (action, s) => action !== "newline" || reaches(s),
      }),
    )
    view.renderOverlay()
  }

  /** Puts `next` over the conversation, in place of the viewer open there if any. */
  function showOverlay(next: SubagentViewer | ExtensionViewer | KeyReference) {
    const opened = viewer !== undefined
    if (viewer instanceof ExtensionViewer) viewer.dispose()
    viewer = next
    if (opened) return
    view.openOverlay()
    // Elapsed times move even when no event comes.
    viewerTimer = setInterval(() => view.requestOverlayRender(), 1000)
  }

  function closeView() {
    if (!viewer) return
    if (viewer instanceof ExtensionViewer) viewer.dispose()
    viewer = undefined
    clearInterval(viewerTimer)
    viewerTimer = undefined
    view.closeOverlay()
    openNextForm()
  }

  /** Shows the first waiting form, unless a dialog, the viewer or another form is up. */
  function openNextForm() {
    const ui = opts.ui
    const next = forms[0]
    if (!ui || !next || form || viewer || dialogs.length) return
    form = new FormView(uiFormBackend(ui, next), {
      requestRender: () => view.requestOverlayRender(),
      waiting: waitingTitles,
      onClose: () => closeForm(next),
    })
    view.openOverlay()
    view.renderOverlay()
    // A form waits for the user like a dialog does: the tab shows it.
    termStatus.setWaiting(true)
  }

  /** The open form was answered, cancelled, or resolved elsewhere: back to the conversation. */
  function closeForm(request: FormRequest) {
    const i = forms.indexOf(request)
    if (i !== -1) forms.splice(i, 1)
    if (!form) return
    form = undefined
    view.closeOverlay()
    termStatus.setWaiting(dialogs.length > 0 || forms.length > 0)
    openNextForm()
  }

  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((r) => {
    resolveExit = r
  })

  const onEvent = (e: AnyEvent) => {
    if (view.subagentEvent(e)) view.requestRender()
    // An extension's view may show anything: it is drawn again at each event (at most once a frame).
    if (viewer instanceof ExtensionViewer || viewer?.handleEvent(e)) view.requestOverlayRender()
    if (form && (e.type === "ui.request" || e.type === "ui.resolved")) view.requestOverlayRender()
    // Sub-agents share the bus; only this session's turn events drive the transcript.
    if (e.sessionId !== agent.sessionId && !HOST_EVENTS.has(e.type)) return
    switch (e.type) {
      case "turn.start": {
        const prompt = e.data.prompt
        // A turn woken by notices carries every one that was waiting.
        if (prompt.display?.origin) pendingNotices.length = 0
        // A turn takes held notices along, so no resend is due any more.
        setRetry(undefined)
        // Messages queued together go as one prompt but read as what they were: one each.
        const merged =
          mergedQueue && messageText(prompt) === mergedQueue.join("\n\n") ? mergedQueue : undefined
        mergedQueue = undefined
        const shown = merged ? merged.map((text) => ({ ...prompt, display: { text } })) : [prompt]
        for (const m of shown) view.user(m)
        termStatus.turnStarted()
        working = true
        thinking = false
        interrupted = false
        turnShowedOutput = false
        if (!clockFromSend) startClock()
        clockFromSend = false
        streamedChars = 0
        spinner.start(() => view.requestRender())
        break
      }
      case "message.start":
        thinking = false
        preparing = undefined
        streamedChars = 0
        break
      case "message.delta":
        if (e.data.kind === "text") {
          thinking = false
          view.replyDelta(e.data.text)
          streamedChars += e.data.text.length
        } else if (e.data.kind === "thinking") {
          thinking = true
          view.reasoningDelta(e.data.text)
          streamedChars += e.data.text.length
        } else {
          streamedChars += e.data.argsDelta.length
          if (e.data.name) {
            thinking = false
            preparing = e.data.name
          }
        }
        break
      case "message.end": {
        const { message } = e.data
        const calls = message.content.flatMap((b) => (b.type === "toolCall" ? [b] : []))
        if (view.replyEnd(calls)) turnShowedOutput = true
        turnTokens += message.usage?.output ?? estimateTokens(streamedChars)
        streamedChars = 0
        break
      }
      case "tool.execute.start":
        preparing = undefined
        view.toolStart(e.data.toolCallId, e.data.name, e.data.args, Date.now())
        // Draw now: the tool may block the event loop before a scheduled frame would run.
        view.render()
        return
      case "tool.execute.update":
        view.toolUpdate(e.data.toolCallId, e.data.partial)
        break
      case "tool.execute.end": {
        const { result, durationMs, rejected } = e.data
        // Whether the user had interrupted is fixed when the call ends, not when it is shown.
        const end = { result, durationMs, interrupted, ...(rejected ? { rejected } : {}) }
        if (view.toolEnd(e.data.toolCallId, end)) turnShowedOutput = true
        break
      }
      case "turn.end":
        if (view.turnEnd()) turnShowedOutput = true
        working = false
        preparing = undefined
        spinner.stop()
        // Steering the turn never reached becomes the next turn, which shows it again.
        steering.length = 0
        if (e.data.reason === "error") view.notice("error", modelErrorNotice(e.data.error))
        else if (e.data.reason === "aborted") view.notice("interrupted", INTERRUPTED_NOTICE)
        else if (!turnShowedOutput) view.notice("info", "No reply")
        termStatus.turnEnded(e.data.reason)
        if (queued.length) {
          const next = queued.splice(0, queued.length)
          const text = next.map((q) => q.text).join("\n\n")
          const shown = next.map((q) => q.display ?? q.text)
          const display = next.some((q) => q.display) ? shown.join("\n\n") : undefined
          mergedQueue = next.length > 1 ? shown : undefined
          queueMicrotask(() => send(outgoing(text, display)))
        }
        break
      case "notice.retry":
        setRetry(e.ts + e.data.delayMs)
        break
      case "workspace.changed":
        termStatus.setBranch(e.data.branch)
        break
      case "compact.start":
        compacting = true
        compactStartedAt = Date.now()
        spinner.start(() => view.requestRender())
        break
      case "compact.end":
        compacting = false
        if (!working) spinner.stop()
        view.notice("success", `Compacted ${e.data.replaced} older messages into a summary.`)
        break
      case "compact.failed":
        compacting = false
        if (!working) spinner.stop()
        if (e.data.blocked) view.notice("info", `Compaction skipped: ${e.data.error}`)
        else view.notice("warning", `Compaction failed: ${e.data.error}`)
        break
      case "extension.error":
        // Settings warnings travel as extension.error from "settings" but are not extension failures.
        view.notice(
          "warning",
          e.data.source === "settings"
            ? `warning: ${e.data.error}`
            : `[extension ${e.data.source}] ${e.data.error}`,
        )
        break
      case "extension.notice":
        view.notice(e.data.level, e.data.text)
        break
      case "turn.steer": {
        const text = messageText(e.data.message)
        // A notice (background sub-agents' results) is not the user's steering. It waits in the
        // bottom area until it joins the conversation (all waiting ones join together), also
        // through an interrupt, after which it goes with the next message.
        if (e.data.message.display?.origin) {
          if (e.data.state === "queued") pendingNotices.push(...userLines(theme, e.data.message))
          else pendingNotices.length = 0
          if (e.data.state === "injected") view.user(e.data.message)
          break
        }
        if (e.data.state === "queued") {
          steering.push(text)
          break
        }
        const i = steering.indexOf(text)
        if (i !== -1) steering.splice(i, 1)
        if (e.data.state === "injected") view.user(e.data.message)
        // Put a message the turn dropped back into the editor rather than losing it.
        else if (e.data.state === "dropped") {
          // A message with folded pastes comes back folded.
          const back = sentParts.get(userText(e.data.message)) ?? [text]
          editor.setParts(editor.isEmpty ? back : [...editor.getParts(), "\n", ...back])
          return redraw()
        }
        // A promoted one shows up again as the next turn's prompt.
        break
      }
      case "ui.request": {
        const ui = opts.ui
        if (!ui) break
        if (e.data.kind === "form") {
          forms.push(e.data)
          openNextForm()
          break
        }
        const dialog = new Dialog(e.data, (answer) => answerDialog(ui, dialog, answer), keys)
        dialogs.push(dialog)
        // Over the viewer or a form it shows only as a banner; the bell rings so it is noticed.
        termStatus.setWaiting(true, viewer !== undefined || form !== undefined)
        break
      }
      case "ui.resolved": {
        const i = dialogs.findIndex((d) => d.request.requestId === e.data.requestId)
        if (i !== -1) dialogs.splice(i, 1)
        const f = forms.find((r) => r.requestId === e.data.requestId)
        // Answered or cancelled elsewhere (another client, a timeout): close it without answering.
        if (f && form && forms[0] === f) form.close()
        else if (f) forms.splice(forms.indexOf(f), 1)
        openNextForm()
        termStatus.setWaiting(dialogs.length > 0)
        break
      }
      case "command.output":
        view.commandOutput(e.data.level, e.data.text)
        break
    }
    view.requestRender()
  }

  /** The activity line counts the turn's time and tokens from here. */
  function startClock() {
    turnStartedAt = Date.now()
    turnTokens = 0
  }

  /** The user's message shows up in the transcript on turn.start. */
  function send(message: Outgoing) {
    const clock = { turnStartedAt, turnTokens }
    working = true
    startClock()
    clockFromSend = true
    view.requestRender()
    agent.prompt(toPrompt(message)).catch((err) => {
      clockFromSend = false
      if (err instanceof AgentBusyError) {
        // A turn we did not know about is running; send this one after it, and keep its clock.
        turnStartedAt = clock.turnStartedAt
        turnTokens = clock.turnTokens
        queued.unshift(message)
      } else {
        working = false
        spinner.stop()
        view.notice("error", err instanceof Error ? err.message : String(err))
      }
      view.requestRender()
    })
  }

  /**
   * Enter and the other send keys: runs a slash command at once, sends, or while a turn runs
   * steers it (D29) or queues the message after it, as `how` says. `parts` is the editor
   * content as typed, folded pastes apart, for the prompt history; `display` shows the pastes
   * as their placeholders in the transcript.
   */
  function submit(text: string, parts: EditorPart[] = [text], display?: string, how = enterDoes) {
    const trimmed = text.trim()
    if (!trimmed) return
    editor.clear()
    history.add(parts)
    historyNav.reset()
    const message = outgoing(trimmed, display)
    remember(message, parts)
    if (commands && parseCommandLine(trimmed)) runCommand(trimmed)
    else if (commands?.skillLine(trimmed)) runSkill(trimmed)
    else if (commands?.inputLine(trimmed)) runInput(trimmed, display)
    else if (working && how === "steer") agent.steer(toPrompt(message))
    else if (working) queued.push(message)
    else send(message)
    view.requestRender()
  }

  /** Sends what the editor holds, as a key other than Enter asks: steering or queued. */
  function submitDraft(how: WhileWorking) {
    submit(editor.getText(), editor.getParts(), editor.getDisplayText(), how)
  }

  /** Runs at once, even during a turn; commands that need an idle session say so. */
  function runCommand(line: string) {
    view.commandEcho(line)
    void commands!
      .run(line, { frontend: "tui", quit: () => quit(), openView })
      .then(() => view.requestRender())
  }

  /**
   * Runs a "$skill" line. No echo: the message the skill sends shows as typed, with a note of
   * what it loaded; a failure shows on its own.
   */
  function runSkill(line: string) {
    void commands!
      .runSkill(line, { frontend: "tui", quit: () => quit(), openView })
      .then(() => view.requestRender())
  }

  /**
   * Runs a line an extension's input handler claimed (e.g. "@writer shorter, please" while a
   * swarm runs), at once, even during a turn. It shows as typed; the model never gets it.
   */
  function runInput(line: string, display?: string) {
    view.commandEcho(display ?? line)
    void commands!
      .runInput(line, { frontend: "tui", quit: () => quit(), openView })
      .then(() => view.requestRender())
  }

  /** A session's history, with its id and last write in the separator. */
  function showHistory(a: Agent) {
    let updatedAt: number | undefined
    try {
      if (a.session?.file) updatedAt = statSync(a.session.file).mtimeMs
    } catch {}
    view.history(a.messages, { id: a.sessionId, ...(updatedAt !== undefined ? { updatedAt } : {}) })
  }

  /** Follows the session a command switched to; a resumed one shows its history. */
  function followAgent(next: Agent) {
    view.leaveSession()
    agent = next
    pendingNotices.length = 0
    setRetry(undefined)
    termStatus.setFolder(next.cwd)
    if (next.messages.length) showHistory(next)
    view.requestRender()
  }

  /** Sets how much of tool results is shown; returns the note that says so. */
  function setDetail(level: ToolDetailLevel): string {
    detail = level
    view.requestRender()
    return view.detailNote(level)
  }

  /** Keeps the folded pastes of the last few messages sent, for a steer the turn drops. */
  function remember(message: Outgoing, parts: EditorPart[]) {
    if (!message.display) return
    sentParts.set(message.text, parts)
    for (const k of sentParts.keys()) {
      if (sentParts.size <= 8) break
      sentParts.delete(k)
    }
  }

  /** Esc or Ctrl+C while working. */
  function interrupt() {
    interrupted = true
    agent.abort()
  }

  function answerDialog(ui: UiRequests, dialog: Dialog, answer: DialogAnswer) {
    const i = dialogs.indexOf(dialog)
    if (i !== -1) dialogs.splice(i, 1)
    termStatus.setWaiting(dialogs.length > 0)
    const { requestId } = dialog.request
    const refused = answer !== undefined && ui.respond(requestId, answer) !== undefined
    if (answer === undefined || refused) ui.cancel(requestId)
    const echoed = refused ? undefined : answer
    // Confirms and questions leave no echo: the tool call that asked shows how it went (allowed,
    // declined, the answer). A command's picker or input keeps one, since nothing else shows it.
    const kind = dialog.request.kind
    if (kind !== "confirm" && kind !== "ask")
      view.dialogEcho((width) => dialogEchoLines(dialog.request, echoed, theme, width))
    view.requestRender()
    openNextForm()
  }

  let quitting = false
  function quit(code = 0) {
    if (quitting) return
    quitting = true
    for (const f of forms.splice(0)) opts.ui?.cancel(f.requestId)
    form?.close()
    closeView()
    off()
    offSwitch?.()
    offCommand?.()
    clearTimeout(hintTimer)
    filePicker.dispose()
    ownFiles?.dispose()
    for (const d of dialogs.splice(0)) opts.ui?.cancel(d.request.requestId)
    spinner.stop()
    setRetry(undefined)
    reader.stop()
    view.stop()
    termStatus.stop()
    if (terminal instanceof ProcessTerminal) terminal.stop()
    else terminal.restore()
    resolveExit(code)
  }

  function onInput(e: InputEvent) {
    // Focus is the terminal's, not a key: it goes to the title and bell even over the viewer,
    // and to extensions as ui.focus when it changes.
    if (e.type === "focus") {
      termStatus.focus(e.focused)
      if (e.focused !== focused) {
        focused = e.focused
        agent.bus.emit("ui.focus", { focused }, { sessionId: "host" })
      }
      return
    }
    // A form or the viewer owns the keyboard while open: the rest is hidden. Ctrl+L repaints it.
    // The wheel scrolls them like ↑↓, as it does on the alternate screen without mouse reporting.
    if (form || viewer) {
      if (keys.is(e, "redraw")) return view.redrawOverlay()
      for (const k of overlayKeys(e)) {
        if (form) form.handleInput(k)
        else viewer?.handleInput(k)
      }
      view.requestOverlayRender()
      return
    }
    const dialog = dialogs[0]
    // Keys of one input chunk arrive before the next frame; the popup must not answer Enter
    // with candidates for text the editor no longer holds.
    if (!dialog && !search.active) syncCompletions()
    if (keys.is(e, "redraw")) {
      // Also over a dialog or the search: they are part of the screen.
      return view.redraw()
    }
    // While a dialog or the history search has the keyboard, the wheel still scrolls the
    // transcript but clicks do not select in it; a drag started before still ends.
    if (e.type === "mouse" && (dialog || search.active) && e.action !== "wheel" && e.action !== "release")
      return
    // The mouse is the transcript's; keys go to the view first while it holds the keyboard.
    // Keys it leaves (Ctrl+C, typing, a paste) go on through the chain below as usual.
    // Esc with text selected clears it before closing a list or the search, or interrupting.
    if (!dialog && view.takeFirst?.(e)) return redraw()
    const viewFirst = e.type === "mouse" || (!dialog && view.capturing)
    if (viewFirst && (view.handleInput(e) || e.type === "mouse")) return redraw()
    if (dialog) {
      // Ctrl+C closes the dialog like Esc (dialog.cancel).
      dialog.handleInput(e)
    } else if (search.active) {
      // Keys like the arrows end the search and then do what they do.
      if (search.handleKey(e) === "accepted-pass") return onInput(e)
    } else if (openPopup() && handlePopupKey(e)) {
      // The popup took one of its keys (popup.*).
    } else if (filePicker.visible && handleFileKey(e)) {
      // The file picker took one of its keys (popup.*).
    } else if (!viewFirst && view.handleInput(e)) {
      // The view took one of its keys (scrolling, find, selecting, copying).
    } else if (keys.is(e, "history.search")) {
      search.start()
    } else if (
      (keys.is(e, "history.prev") || keys.is(e, "history.next")) &&
      historyNav.move(keys.is(e, "history.prev") ? -1 : 1)
    ) {
      // The key walked the prompt history.
    } else if (keys.is(e, "queue")) {
      // Alt+Enter or Ctrl+Q: the other of what Enter does while a turn runs.
      submitDraft(otherWay(enterDoes))
    } else if (keys.is(e, "submit.steer")) {
      submitDraft("steer")
    } else if (keys.is(e, "submit.queue")) {
      submitDraft("queue")
    } else if (keys.is(e, "cancel")) {
      if (working) interrupt()
      else if (!editor.isEmpty) editor.clear()
      else return quit()
    } else if (keys.is(e, "exit") && !working && editor.isEmpty) {
      return quit()
    } else if (keys.is(e, "tool-output")) {
      showNote(setDetail(nextDetail(detail)))
    } else if (keys.is(e, "panels.toggle") && panelsShown) {
      panelsCollapsed = !panelsCollapsed
    } else if (keys.is(e, "help") && editor.isEmpty) {
      // Lists open only on text, so an empty input has none; a dialog took the key above.
      return openKeyReference()
    } else if (keys.is(e, "interrupt")) {
      // A /compact runs without a turn; interrupt stops it too.
      if (working || compacting) interrupt()
    } else {
      editor.handleInput(e)
    }
    redraw()
  }

  /**
   * Brings the popup up to the editor text, then asks for a frame. Candidates the host has at
   * once (command names, sync completers) show in the same frame as the key; async ones get
   * up to a frame to arrive (the popup redraws when they do), so a key paints once, not twice.
   * Completion runs here, on input, never while rendering.
   */
  function redraw() {
    const pending = syncCompletions()
    if (pending) setTimeout(() => view.requestRender(), FRAME_MS)
    else view.requestRender()
  }

  /** Applies what the popup did with a key; false when it left the key to the editor. */
  function handlePopupKey(e: InputEvent): boolean {
    const action = openPopup()!.handleKey(e)
    if (!action) return false
    if (action.type === "replace") editor.setText(action.text)
    else if (action.type === "run") {
      history.add([action.line])
      historyNav.reset()
      editor.clear()
      if (action.line.startsWith("$")) runSkill(action.line)
      else runCommand(action.line)
    }
    return true
  }

  /** Applies what the file picker did with a key; false when it left the key to the editor. */
  function handleFileKey(e: InputEvent): boolean {
    const action = filePicker.handleKey(e)
    if (!action) return false
    if (action.type === "insert") editor.replaceBeforeCaret(action.replace, action.text)
    return true
  }

  const off = agent.bus.subscribe(onEvent)
  const offSwitch = commands?.onSwitch(followAgent)
  const offCommand = opts.registerCommand?.(
    detailCommand(
      () => detail,
      (level) => setDetail(level),
    ),
  )
  opts.onReady?.()
  const reader = new InputReader(terminal, onInput)
  reader.start()
  termStatus.start()
  view.banner(
    `${theme.accent("Amira")} ${theme.muted(`· ${modelLabel({ provider: agent.model.provider, model: agent.model.id })} · ${agent.cwd}`)}`,
  )
  if (agent.messages.length) showHistory(agent)
  for (const e of opts.startupEvents ?? []) onEvent(e)
  if (opts.notice) view.notice("warning", opts.notice)
  // The first frame carries the banner, history and startup messages.
  view.start()
  if (opts.initialPrompt?.trim()) submit(opts.initialPrompt)
  if (leftoverInput) reader.feed(leftoverInput)

  return exited
}

/** The events an overlay gets for one: the wheel as ↑ or ↓ three times, mouse clicks not at all. */
function overlayKeys(e: InputEvent): InputEvent[] {
  if (e.type !== "mouse") return [e]
  if (e.action !== "wheel" || (e.button !== "up" && e.button !== "down")) return []
  const k: InputEvent = { type: "key", name: e.button, ctrl: false, shift: false, alt: false }
  return [k, k, k]
}
