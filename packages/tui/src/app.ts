import { spawnSync } from "node:child_process"
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isNoModel, type ServerToolBlock } from "@amira/ai"
import {
  type AnyEvent,
  type EventMap,
  type FileRewindPlan,
  type FrontendView,
  isSubagentView,
  modelLabel,
  type SessionControl,
  type ToolDetailLevel,
  type UserMessage,
} from "@amira/api"
import { type Agent, AgentBusyError, MODE_SUMMARY, parseCommandLine, type UiRequests } from "@amira/core"
import {
  type Component,
  chooseImageSupport,
  colorSupported,
  defaultTheme,
  detectEnv,
  Editor,
  type EditorImage,
  type EditorPart,
  ImageStore,
  type InputEvent,
  InputReader,
  isColorEnabled,
  monoTheme,
  ProcessTerminal,
  progressSupported,
  type RenderContext,
  Spinner,
  Stack,
  setupTerminalInput,
  supportsHyperlinks,
  surfaceTheme,
  truncateToWidth,
} from "@amira/tui-kit"
import { createTurnActivity, statusRetryLabel } from "./app/activity.ts"
import { copyToClipboard, lastReplyText } from "./clipboard.ts"
import { CommandPopup } from "./command-popup.ts"
import { Dialog, type DialogAnswer, type DialogRequest, dialogEchoLines } from "./dialog.ts"
import { renderToolLines } from "./diff-view.ts"
import { ExtensionViewer } from "./extension-view.ts"
import { FileIndex } from "./file-index.ts"
import { FilePicker } from "./file-picker.ts"
import { type FormRequest, FormView, uiFormBackend } from "./form-view.ts"
import { compactionNotice, userText } from "./format.ts"
import { createFullscreenView } from "./fullscreen-view.ts"
import { glyphs } from "./glyphs.ts"
import { fitHint } from "./hint.ts"
import { HistorySearch } from "./history-search.ts"
import {
  imageBytes,
  imageMimeType,
  MAX_IMAGE_BYTES,
  pastedImagePaths,
  readClipboard,
  readImage,
} from "./image-input.ts"
import { createInlineView } from "./inline-view.ts"
import { InputBox } from "./input-box.ts"
import { KeyReference } from "./key-reference.ts"
import { defaultKeys, Keybindings, type KeySpec } from "./keybindings.ts"
import { ReplyRenderers } from "./markdown-nodes.ts"
import { HistoryNavigator, PromptHistory } from "./prompt-history.ts"
import { replyCitations, serverToolCall } from "./server-tools.ts"
import { type StatusEntry, statusLine } from "./status-bar.ts"
import { SubagentViewer } from "./subagent-view.ts"
import { TerminalStatus } from "./terminal-status.ts"
import { INTERRUPTED_NOTICE, modelErrorNotice } from "./transcript.ts"
import { detailCommand, nextDetail } from "./verbose.ts"
import { type TranscriptView, View, type ViewHost } from "./view.ts"

export type { RetryState } from "./app/activity.ts"
export { activityLabel, lastReasoningLine, retryLabel, statusRetryLabel } from "./app/activity.ts"

import type { CommandRunner } from "./app/command-runner.ts"
import { createCommandRunner } from "./app/command-runner.ts"
import {
  createNoticeStrip,
  draftMessage,
  messageParts,
  messageText,
  type NoticeStrip,
  type Outgoing,
  oneLine,
  otherWay,
  outgoing,
  pendingMessageRows,
  toPrompt,
  type WhileWorking,
} from "./app/outbox.ts"

export { pendingMessageRows } from "./app/outbox.ts"

import type { InteractiveOptions } from "./app/startup.ts"
import {
  DOUBLE_ESC_MS,
  FOLD_PASTES,
  FRAME_MS,
  HINT_NOTE_MS,
  HOST_EVENTS,
  overlayKeys,
  REWIND_ID,
  tildePath,
  welcomeCard,
} from "./app/startup.ts"

export type { InteractiveOptions } from "./app/startup.ts"
export { tildePath } from "./app/startup.ts"

/** The items of a hint line, most useful ones with the highest priority. */
type HintItems = Parameters<typeof fitHint>[0]

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
  const activity = createTurnActivity()
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
  /** Counts the messages typed, so that steering and queued ones merge in the order they were. */
  let typed = 0
  /** When each recent steering message was typed, by its text. */
  const steerSeq = new Map<string, number>()
  /**
   * Set when the user stopped a turn while messages waited: the steering it drops is collected
   * here, to go out with the queued messages at turn.end (or back into the editor to rewind).
   */
  let flush: { dropped: Outgoing[]; rewind: boolean } | undefined
  /** The merged messages about to go, while a second Esc may still turn the stop into a rewind. */
  let flushTimer: { next: Outgoing[]; timer: ReturnType<typeof setTimeout> } | undefined
  /** When the interrupt key was last pressed, to tell a double press. */
  let lastInterruptAt = 0
  /** Open extension dialogs; the first one has the keyboard. */
  const dialogs: Dialog[] = []
  /** Whether the current turn showed anything besides the user's message. */
  let turnShowedOutput = false
  /**
   * The provider's own tool calls (hosted web search) shown as rows this turn: when each
   * started, and whether it ended.
   */
  const serverRows = new Map<string, { startedAt: number; ended: boolean }>()
  /** Reply text streamed since the last such row started. */
  let textSinceRow = true
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
  const clipboardAbort = new AbortController()
  let clipboardRead: AbortController | undefined

  function cancelClipboard() {
    clipboardRead?.abort()
    clipboardRead = undefined
  }

  function attachImages(attachments: EditorImage[]): boolean {
    const bytes = imageBytes([...editor.getParts(), ...attachments.map((image) => ({ image }))])
    if (bytes > MAX_IMAGE_BYTES) {
      showNote("Images in a message are limited to 5 MB total. Remove an attachment or resize it first.")
      return false
    }
    for (const image of attachments) editor.insertImage(image)
    showNote(
      `Attached ${attachments.map((image) => image.name.replace(/\p{Cc}/gu, " ")).join(", ")}. Backspace removes an attachment.`,
    )
    return true
  }

  function pasteText(text: string) {
    const paths = pastedImagePaths(text, agent.cwd)
    let images: EditorImage[] | undefined
    try {
      images = paths?.map(readImage)
    } catch (err) {
      // An image that cannot be attached stays a path in the text rather than vanishing.
      showNote(`${err instanceof Error ? err.message : String(err)} Pasted as text.`)
    }
    if (!images || !attachImages(images)) editor.handleInput({ type: "paste", text })
    redraw()
  }

  async function pasteClipboard() {
    if (clipboardRead) return
    const read = new AbortController()
    clipboardRead = read
    const signal = AbortSignal.any([clipboardAbort.signal, read.signal])
    const session = agent
    try {
      const result = await (opts.clipboard
        ? opts.clipboard(agent.cwd, signal)
        : readClipboard({ cwd: agent.cwd, env: { ...process.env, ...env }, signal }))
      if (signal.aborted || agent !== session) return
      if (result.type === "image") attachImages([result.image])
      else if (result.type === "text") pasteText(result.text)
      else showNote("No image or text on the clipboard. You can also paste an image file path.")
    } catch (err) {
      if (!signal.aborted) showNote(err instanceof Error ? err.message : String(err))
    } finally {
      if (clipboardRead === read) clipboardRead = undefined
      if (!clipboardAbort.signal.aborted) redraw()
    }
  }
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
   * A prompt ↑/↓ recalled opens no list until it is edited: the list would take ↑/↓, and the
   * walk would stop at the first "/status", "$skill" or "@file" in the history.
   */
  const syncCompletions = (): Promise<void> | undefined => {
    const recalled = historyNav.recalling
    const line =
      editor.lineCount === 1 &&
      !recalled &&
      !editor.getParts().some((p) => typeof p !== "string" && "image" in p)
        ? editor.getText()
        : ""
    const commandsPending = popups.map((p) => p.update(line)).find(Boolean)
    filePicker.update(recalled ? "" : editor.textBeforeCaret())
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
  /**
   * The status in the input's border: the extensions' items and, when it is not the default
   * auto, the permission mode, next to the model.
   */
  const statusItems = (): StatusEntry[] => {
    const mode = agent.permissions.mode
    const own: StatusEntry[] =
      mode === "auto"
        ? []
        : [
            {
              id: "permissions.mode",
              align: "left",
              tone: mode === "plan" ? "warning" : "default",
              priority: 35,
              text: `${mode} mode`,
            },
          ]
    const items = opts.status.snapshot()
    // After the model, which extensions put first.
    const at = items.findIndex((i) => i.id !== "model" && i.align === "left")
    return at < 0 ? [...items, ...own] : [...items.slice(0, at), ...own, ...items.slice(at)]
  }
  const inputBox = new InputBox(editor, statusItems)
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
  /** The most rows the list below the input had since it opened (full screen keeps them). */
  let listRows = 0
  let noticeStrip: NoticeStrip | undefined
  let commandRunner: CommandRunner | undefined

  /** The panels' rows; unfolded, a blank row sets each panel apart from the one before. */
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
    )
      .map((p) => renderToolLines(p.lines, ctx.theme, width))
      .filter((rows) => rows.length > 0)
      .flatMap((rows, i) => (i > 0 && !collapsed ? ["", ...rows] : rows))

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
    // The activity line: a summary of the turn (what it does now, how long it has run, the
    // tokens it wrote), and while the model thinks the last line of its reasoning. It shows for
    // the whole turn; running tools are counted here and named on their own rows. How to
    // interrupt is on the hint line.
    new View((width, ctx) => {
      return activity.render(width, ctx, {
        running: view.runningTools,
        waiting: dialogs.length > 0,
        spinner,
      })
    }),
    new View((width, ctx) => [
      ...(noticeStrip?.render(ctx.theme) ?? []).map((l) => truncateToWidth(l, width, "…")),
      ...pendingMessageRows(
        [
          ...steering.map((text) => ({ label: "steering", text })),
          ...queued.map((q) => ({ label: "queued", text: q.display ?? q.text })),
        ],
        width,
        ctx.theme,
      ),
    ]),
    // The input box carries the status in its bottom border. A dialog takes the box's place;
    // the status then gets a line of its own under it.
    new View((width, ctx) => {
      if (!dialogs[0]) return inputBox.render(width, ctx)
      const lines = dialogs[0].render(width, ctx)
      dialogRows = lines.length
      return [...lines, ...statusLine(statusItems(), width, ctx)]
    }),
    // The command or skill list, file list or history search opens below the input box, in place of
    // the hint, so the box stays where it is while the list changes with each key. Full screen,
    // the bottom area is drawn up from the screen's last row: the list keeps the most rows it had
    // since it opened (blank ones below it), so the box does not jump as it gets shorter.
    new View((width, ctx) => {
      const list = dialogs[0] ? undefined : inputList()
      if (!list) {
        listRows = 0
        return []
      }
      const rows = list.lines(width, ctx)
      if (mode === "fullscreen") {
        listRows = Math.max(listRows, rows.length)
        while (rows.length < listRows) rows.push("")
      }
      return [...rows, ctx.theme.muted(fitHint(list.hint(), width))]
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
    // The blank rows a list keeps (full screen) go before anything else: the terminal shrank,
    // or the rows above the box grew, since the list was that tall.
    if (listRows && rest.length > budget) {
      listRows = Math.max(0, listRows - (rest.length - budget))
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
    // A /compact is a command too, but its hint below says "interrupt", as it always did.
    if (commandRunner?.hasCancellable() && !activity.compacting)
      return [
        submitKey && { text: `${submitKey} ${activity.working ? enterDoes : "send"}`, priority: 5 },
        interruptKey && { text: `${interruptKey} cancel command`, priority: 4 },
      ]
    if (activity.working) {
      // Esc stops the turn; with messages waiting it sends them at once, merged.
      const waiting = queued.length > 0 || steering.length > 0
      return [
        submitKey && { text: `${submitKey} ${enterDoes}`, priority: 5 },
        queueKey && { text: `${queueKey} ${otherWay(enterDoes)}`, priority: 3 },
        interruptKey && { text: `${interruptKey} ${waiting ? "send queued" : "interrupt"}`, priority: 4 },
        interruptKey && canRewind() && { text: `${interruptKey} ${interruptKey} rewind`, priority: 1 },
      ]
    }
    const helpKey = keys.label("help")
    // Folded panels hide rows: say how to get them back.
    const panelsKey = keys.label("panels.toggle")
    return [
      panelsCollapsed && panelsShown && panelsKey && { text: `${panelsKey} unfold panels`, priority: 2 },
      submitKey && { text: `${submitKey} send`, priority: 5 },
      // A /compact runs without a turn; the interrupt key stops it too.
      activity.compacting && interruptKey && { text: `${interruptKey} interrupt`, priority: 4 },
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
    // A usage line or "no command matches": nothing to pick or complete.
    if (!popups.find((p) => p.visible)?.hasCandidates)
      return [close && { text: `${close} close`, priority: 4 }]
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
    ...(commands ? { openSubagent: (id: string) => openView({ kind: "subagent", sessionId: id }) } : {}),
  }
  // A dumb terminal has no alternate screen to draw the full-screen view on.
  const mode = env.TERM === "dumb" ? "inline" : (opts.mode ?? settings.mode ?? "inline")
  const view: TranscriptView = mode === "fullscreen" ? createFullscreenView(host) : createInlineView(host)
  noticeStrip = createNoticeStrip({ theme, requestRender: () => view.requestRender() })
  commandRunner = createCommandRunner({
    commands,
    keys,
    mode,
    reaches,
    commandEcho: (line) => view.commandEcho(line),
    commandOutput: (level, text) => view.commandOutput(level, text),
    requestRender: () => view.requestRender(),
    quit: () => quit(),
    openView,
    openRewind,
    isCompacting: () => activity.compacting,
    interrupt: () => interrupt(),
  })

  /** Shows a full-screen view; false when it cannot be shown now (see CommandContext.openView). */
  function openView(v: FrontendView): boolean {
    if (isSubagentView(v)) {
      // A form owns the screen until it is answered; a dumb terminal has no screen to show it on.
      if (!commands || form || env.TERM === "dumb") return false
      if (viewer instanceof SubagentViewer) viewer.show(v.sessionId)
      else {
        showOverlay(
          new SubagentViewer(v.sessionId, {
            source: commands.control,
            waiting: waitingTitles,
            onClose: closeView,
            // p: back to the conversation, with a snapshot of the one shown printed into it.
            onPrint: (id) => {
              closeView()
              commandRunner!.run(`/agents ${id}`)
            },
            ...(presenters ? { presenters } : {}),
          }),
        )
      }
      view.renderOverlay()
      return true
    }
    const definition = opts.views?.get(v.kind)
    if (!definition) throw new Error(`there is no "${v.kind}" view`)
    if (form) return false
    if (viewer instanceof ExtensionViewer && viewer.kind === v.kind) viewer.show(v.data)
    else {
      showOverlay(
        new ExtensionViewer(definition, v.data, {
          waiting: waitingTitles,
          onClose: closeView,
          requestRender: () => view.requestOverlayRender(),
          onError: (error) => view.notice("warning", `View ${v.kind}: ${error}`),
        }),
      )
    }
    view.renderOverlay()
    return true
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

  /**
   * A tool the provider runs (its hosted web search) as a tool row: it starts when first seen,
   * after what the reply said before it, and ends once the provider says it finished (or, at
   * the reply's end, `final`, as it was left).
   */
  function serverRow(b: ServerToolBlock, final = false) {
    const call = serverToolCall(b)
    let row = serverRows.get(b.id)
    if (row?.ended) return
    if (!row) {
      if (final && b.status === "running") return
      row = { startedAt: Date.now(), ended: false }
      serverRows.set(b.id, row)
      if (view.replyEnd([])) turnShowedOutput = true
      textSinceRow = false
    }
    view.toolStart(b.id, call.name, call.args, row.startedAt)
    if (b.status === "running" && !final) return
    row.ended = true
    const end = {
      result: call.result,
      durationMs: Date.now() - row.startedAt,
      interrupted,
      ...(call.rejected ? { rejected: call.rejected } : {}),
    }
    if (view.toolEnd(b.id, end)) turnShowedOutput = true
  }

  const onEvent = (e: AnyEvent) => {
    if (view.subagentEvent(e)) view.requestRender()
    // An extension's view may show anything: it is drawn again at each event (at most once a frame).
    if (viewer instanceof ExtensionViewer || viewer?.handleEvent(e)) view.requestOverlayRender()
    if (form && (e.type === "ui.request" || e.type === "ui.resolved")) view.requestOverlayRender()
    // Sub-agents share the bus; only this session's turn events drive the transcript.
    if (e.sessionId !== agent.sessionId && !HOST_EVENTS.has(e.type)) return
    switch (e.type) {
      case "session.title":
        termStatus.setSessionTitle(e.data.title)
        break
      case "turn.start": {
        const prompt = e.data.prompt
        // A turn woken by notices carries every one that was waiting.
        noticeStrip!.turnStarted(prompt)
        // Messages queued together go as one prompt but read as what they were: one each.
        const merged =
          mergedQueue && messageText(prompt) === mergedQueue.join("\n\n") ? mergedQueue : undefined
        mergedQueue = undefined
        const shown = merged ? merged.map((text) => ({ ...prompt, display: { text } })) : [prompt]
        if (commandRunner!.takeEcho(prompt)) commandRunner!.echoedNote(prompt)
        else for (const m of shown) view.user(m)
        termStatus.turnStarted()
        activity.turnStarted(() => {
          interrupted = false
          turnShowedOutput = false
        })
        spinner.start(() => view.requestRender())
        break
      }
      case "model.retry":
        activity.setRetry({ ...e.data, at: e.ts + e.data.delayMs })
        break
      case "message.start":
        activity.messageStarted()
        break
      case "message.delta":
        if (e.data.kind === "text") {
          const text = e.data.text
          activity.textDelta(text, () => {
            view.replyDelta(text)
            textSinceRow = true
          })
        } else if (e.data.kind === "thinking") {
          const text = e.data.text
          activity.thinkingDelta(text, () => view.reasoningDelta(text))
        } else if (e.data.kind === "serverTool") {
          const block = e.data.block
          activity.serverToolDelta(() => serverRow(block))
        } else {
          activity.toolCallDelta(e.data.argsDelta.length, e.data.name)
        }
        break
      case "message.end": {
        const { message } = e.data
        // Searches the provider left unfinished end with the reply; the sources it cited follow it.
        for (const b of message.content) if (b.type === "serverTool") serverRow(b, true)
        const sources = replyCitations(message.content)
        // Right after a search row the list starts a block of its own: no blank rows first.
        if (sources) view.replyDelta(textSinceRow ? sources : sources.trimStart())
        textSinceRow = true
        const calls = message.content.flatMap((b) => (b.type === "toolCall" ? [b] : []))
        if (view.replyEnd(calls)) turnShowedOutput = true
        activity.messageEnded(message.usage?.output)
        break
      }
      case "tool.execute.start":
        activity.toolStarted()
        view.toolStart(e.data.toolCallId, e.data.name, e.data.args, Date.now())
        // Draw now: the tool may block the event loop before a scheduled frame would run.
        view.render()
        return
      case "tool.execute.update":
        view.toolUpdate(e.data.toolCallId, e.data.partial)
        break
      case "tool.execute.end": {
        const { result, durationMs, rejected, approval } = e.data
        // Whether the user had interrupted is fixed when the call ends, not when it is shown.
        const end = {
          result,
          durationMs,
          interrupted,
          ...(rejected ? { rejected } : {}),
          ...(approval ? { approval } : {}),
        }
        if (view.toolEnd(e.data.toolCallId, end)) turnShowedOutput = true
        break
      }
      case "turn.end":
        serverRows.clear()
        if (view.turnEnd()) turnShowedOutput = true
        activity.turnEnded()
        spinner.stop()
        // Steering the turn never reached becomes the next turn, which shows it again.
        steering.length = 0
        activity.setRetry(undefined)
        if (e.data.reason === "error") errorNotice(e.data)
        else if (e.data.reason === "aborted") view.notice("interrupted", interruptedText())
        else if (!turnShowedOutput) view.notice("info", "No reply")
        termStatus.turnEnded(e.data.reason)
        if (flush) {
          // Stopped with Esc: the steering the turn dropped and the queued messages go out as
          // one, in the order they were typed; unless a second Esc asked to rewind instead.
          const next = [...flush.dropped, ...queued.splice(0)].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
          const rewind = flush.rewind
          flush = undefined
          if (rewind) {
            putBack(next)
            queueMicrotask(() => void openRewind())
          } else if (next.length) {
            // Wait out the rest of a double press: a second Esc still means rewind.
            const wait = Math.max(0, DOUBLE_ESC_MS - (Date.now() - lastInterruptAt))
            flushTimer = { next, timer: setTimeout(() => sendMerged(next), wait) }
          }
        } else if (queued.length) {
          const next = queued.splice(0, queued.length)
          queueMicrotask(() => sendMerged(next))
        }
        break
      case "notice.retry":
        noticeStrip!.setRetry(e.ts + e.data.delayMs)
        break
      case "status.changed":
        // A failed model request tried again says so until the stream goes on (or the turn ends).
        activity.setRetrying(statusRetryLabel(e.data as Parameters<typeof statusRetryLabel>[0]))
        break
      case "workspace.changed":
        termStatus.setBranch(e.data.branch)
        break
      case "compact.start":
        activity.startCompaction(e.data.native === true)
        spinner.start(() => view.requestRender())
        break
      case "compact.end":
        activity.endCompaction()
        if (!activity.working) spinner.stop()
        view.notice("success", compactionNotice(e.data.replaced, e.data))
        break
      case "compact.failed":
        activity.endCompaction()
        if (!activity.working) spinner.stop()
        if (e.data.empty) view.notice("info", "Nothing to compact yet.")
        else if (e.data.blocked) view.notice("info", `Compaction skipped: ${e.data.error}`)
        else view.notice("warning", `Compaction failed: ${e.data.error}`)
        break
      case "extension.error":
        // Settings warnings travel as extension.error from "settings" but are not extension failures.
        view.notice(
          "warning",
          // The glyph says it is a warning; the text says where from.
          e.data.source === "settings"
            ? `Settings: ${e.data.error}`
            : `Extension ${e.data.source}: ${e.data.error}`,
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
        if (noticeStrip!.steer(e.data.message, e.data.state)) {
          if (e.data.state === "injected") view.user(e.data.message)
          break
        }
        if (e.data.state === "queued") {
          steering.push(text)
          break
        }
        const i = steering.indexOf(text)
        if (i !== -1) steering.splice(i, 1)
        const echoed = e.data.state !== "promoted" && commandRunner!.takeEcho(e.data.message)
        if (e.data.state === "injected") {
          if (echoed) commandRunner!.echoedNote(e.data.message)
          else view.user(e.data.message)
        }
        // Stopped with Esc while messages waited: it goes out again at once, with the queued ones.
        else if (e.data.state === "dropped" && flush) {
          const m = e.data.message
          flush.dropped.push({
            ...draftMessage(userText(m), m.display?.text, messageParts(m)),
            seq: steerSeq.get(userText(m)) ?? 0,
          })
        }
        // Put a message the turn dropped back into the editor rather than losing it.
        else if (e.data.state === "dropped") {
          // A message with folded pastes comes back folded.
          const back = e.data.message.content.some((b) => b.type === "image")
            ? messageParts(e.data.message)
            : (sentParts.get(userText(e.data.message)) ?? [text])
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

  /** A failed turn: what went wrong in plain words and what to do, the provider's text folded. */
  function errorNotice(end: EventMap["turn.end"]) {
    const f = end.failure
    // Without a next step of its own, the notice says what the user can always do.
    if (!f) return view.notice("error", modelErrorNotice(end.error))
    view.notice("error", f.hint ? `${f.summary}\n${f.hint}` : modelErrorNotice(f.summary), f.detail)
  }

  /** Sub-agents (also a workflow's or a swarm's) still running in the background. */
  const runningSubagents = () => agent.tree?.children.length ?? 0

  /** "Interrupted", and that sub-agents run on in the background (an interrupt stops only the turn). */
  function interruptedText(): string {
    const n = runningSubagents()
    return n
      ? `${INTERRUPTED_NOTICE} · ${n} sub-agent${n === 1 ? "" : "s"} still running · /agents`
      : INTERRUPTED_NOTICE
  }

  /** Background jobs (dev servers, watchers) still running. */
  const runningJobs = () => {
    try {
      return opts.runningJobs?.() ?? 0
    } catch {
      return 0
    }
  }

  /** Until when a second Ctrl+C or Ctrl+D quits although sub-agents or background jobs run. */
  let quitArmedUntil = 0
  /**
   * Ctrl+C or Ctrl+D on an empty, idle input: quits, unless sub-agents or background jobs still
   * run; then the first press says so and a second one (while the note shows) quits.
   */
  function quitOrWarn(action: "cancel" | "exit") {
    const n = runningSubagents()
    const jobs = runningJobs()
    if ((!n && !jobs) || Date.now() < quitArmedUntil) return quit()
    quitArmedUntil = Date.now() + HINT_NOTE_MS
    const key = keys.label(action) ?? "Ctrl+C"
    const what = [
      n ? `${n} sub-agent${n === 1 ? "" : "s"}` : "",
      jobs ? `${jobs} background job${jobs === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" and ")
    showNote(`${what} still running — ${key} again to stop them and quit`)
  }

  /** Whether no provider is configured: from the session when it says, else from the CLI's notice. */
  function noProviders(): boolean {
    const providers = commands?.control.providers
    if (providers) {
      try {
        return providers().length === 0
      } catch {}
    }
    return opts.notice?.startsWith("No providers") ?? false
  }

  /**
   * Sending while no model is picked would only fail: the message stays in the editor, and a
   * notice says what to do first.
   */
  function noModelYet(parts: EditorPart[]): boolean {
    if (!isNoModel(agent.model)) return false
    editor.setParts(parts)
    view.notice(
      "error",
      noProviders()
        ? "No providers configured: add one with /provider add, then pick a model with /model. Your message is still in the input."
        : "No model selected: pick one with /model. Your message is still in the input.",
    )
    return true
  }

  /** The user's message shows up in the transcript on turn.start. */
  function send(message: Outgoing) {
    if (message.content?.some((b) => b.type === "image") && !agent.model.caps.images) {
      putBack([message])
      view.notice(
        "warning",
        "This model does not support images. Pick an image-capable model with /model or remove the attachments. Your message is still in the input.",
      )
      view.requestRender()
      return
    }
    const clock = activity.beginSend()
    view.requestRender()
    agent.prompt(toPrompt(message)).catch((err) => {
      const busy = err instanceof AgentBusyError
      activity.sendFailed(clock, busy)
      if (busy) {
        // A turn we did not know about is running; send this one after it, and keep its clock.
        queued.unshift(message)
      } else {
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
    const hasImages = parts.some((p) => typeof p !== "string" && "image" in p)
    if (
      clipboardRead ||
      (hasImages &&
        (imageBytes(parts) > MAX_IMAGE_BYTES || (!isNoModel(agent.model) && !agent.model.caps.images)))
    ) {
      editor.setParts(parts)
      view.notice(
        "warning",
        clipboardRead
          ? "Clipboard paste is still loading. Send the message once it finishes."
          : imageBytes(parts) > MAX_IMAGE_BYTES
            ? "Images in a message are limited to 5 MB total. Remove an attachment or resize it first."
            : "This model does not support images. Pick an image-capable model with /model or remove the attachments. Your message is still in the input.",
      )
      return
    }
    if (!trimmed && !hasImages) return
    editor.clear()
    history.add(parts)
    historyNav.reset()
    const message: Outgoing = { ...draftMessage(trimmed, display, parts), seq: ++typed }
    remember(message, parts)
    // Messages an Esc released still wait out a double press: they were typed first, so they go
    // first, and this one joins the turn they start (or is queued after it).
    if (flushTimer) {
      clearTimeout(flushTimer.timer)
      sendMerged(flushTimer.next)
    }
    if (!hasImages && commands && parseCommandLine(trimmed)) commandRunner!.run(trimmed)
    else if (!hasImages && commands?.skillLine(trimmed)) runSkill(trimmed)
    else if (!hasImages && commands?.inputLine(trimmed)) runInput(trimmed, display)
    else if (activity.working && how === "steer") {
      steerSeq.set(message.text, message.seq!)
      for (const k of steerSeq.keys()) {
        if (steerSeq.size <= 16) break
        steerSeq.delete(k)
      }
      agent.steer(toPrompt(message))
    } else if (activity.working) queued.push(message)
    else if (!noModelYet(parts)) send(message)
    view.requestRender()
  }

  /** Sends what the editor holds, as a key other than Enter asks: steering or queued. */
  function submitDraft(how: WhileWorking) {
    submit(editor.getText(), editor.getParts(), editor.getDisplayText(), how)
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

  /**
   * Shows the session `a` from here: the boundary with its id (and last write, resumed), then
   * its history. `switched` by a command, full screen starts the transcript afresh.
   */
  function showSession(a: Agent, switched: boolean) {
    let updatedAt: number | undefined
    try {
      if (a.session?.file && a.messages.length) updatedAt = statSync(a.session.file).mtimeMs
    } catch {}
    const boundary = {
      id: a.sessionId,
      resumed: a.messages.length > 0,
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    }
    view.openSession(boundary, a.messages, switched, (m) => a.compactionInfo(m))
  }

  /** Follows the session a command switched to (/clear, /resume), from a boundary naming it. */
  function followAgent(next: Agent) {
    cancelClipboard()
    view.leaveSession()
    agent = next
    commandRunner!.clearEchoes()
    noticeStrip!.reset()
    termStatus.setFolder(next.cwd)
    termStatus.setSessionTitle(next.session?.title)
    showSession(next, true)
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

  /** Sends messages as one prompt that the transcript still shows one by one. */
  function sendMerged(next: Outgoing[]) {
    if (flushTimer?.next === next) flushTimer = undefined
    if (!next.length) return
    const text = next.map((q) => q.text).join("\n\n")
    const shown = next.map((q) => q.display ?? q.text)
    const display = next.some((q) => q.display) ? shown.join("\n\n") : undefined
    mergedQueue = next.length > 1 ? shown : undefined
    const message = outgoing(text, display)
    if (next.some((q) => q.content)) {
      message.content = next.flatMap((q, i) => [
        ...(i ? [{ type: "text" as const, text: "\n\n" }] : []),
        ...(q.content ?? [{ type: "text" as const, text: q.text }]),
      ])
      message.parts = next.flatMap((q, i) => [
        ...(i ? ["\n\n"] : []),
        ...(q.parts ?? sentParts.get(q.text) ?? [q.text]),
      ])
      if (imageBytes(message.parts) > MAX_IMAGE_BYTES) {
        putBack(next)
        view.notice("warning", "Images in the combined message exceed 5 MB. Send the attachments separately.")
        return
      }
    }
    send(message)
  }

  /** Puts messages that were about to go back into the editor, before what it holds. */
  function putBack(next: Outgoing[]) {
    if (!next.length) return
    const parts: EditorPart[] = []
    for (const q of next) {
      if (parts.length) parts.push("\n\n")
      parts.push(...(q.parts ?? sentParts.get(q.text) ?? [q.text]))
    }
    if (!editor.isEmpty) parts.push("\n\n", ...editor.getParts())
    editor.setParts(parts)
  }

  /**
   * Esc or Ctrl+C while working. With steering or queued messages waiting, the turn stops and
   * they go out at once, merged in the order they were typed (on turn.end).
   */
  function interrupt() {
    interrupted = true
    if (activity.working && !flush && (queued.length || steering.length))
      flush = { dropped: [], rewind: false }
    agent.abort()
  }

  /** Whether the conversation can be rewound: the host keeps a session file. */
  function canRewind(): boolean {
    return commands?.control.rewind !== undefined
  }

  /**
   * The interrupt key (Esc). Once: stops the turn (sending what waits, see interrupt). Twice in
   * a row: stops it and opens the rewind picker, the waiting messages back in the editor.
   */
  function pressInterrupt() {
    const now = Date.now()
    const double = now - lastInterruptAt < DOUBLE_ESC_MS
    lastInterruptAt = double ? 0 : now
    if (!double) {
      if (activity.working || activity.compacting) interrupt()
      return
    }
    if (!canRewind()) {
      if (activity.working || activity.compacting) interrupt()
      return
    }
    // The merged send was waiting out the double press: hold it in the editor instead.
    if (flushTimer) {
      clearTimeout(flushTimer.timer)
      putBack(flushTimer.next)
      flushTimer = undefined
    }
    if (activity.working) {
      if (!flush) flush = { dropped: [], rewind: true }
      else flush.rewind = true
      interrupt()
    } else if (!activity.compacting) openRewind()
  }

  /**
   * The rewind picker: the user's messages, newest first. Picking one cuts the conversation
   * back to just before it and puts it in the editor to change and send again. The second
   * choice previews file restoration, including the host's coverage and conflicts.
   */
  function openRewind(): boolean {
    const control = commands?.control
    if (
      !control?.rewind ||
      activity.working ||
      activity.compacting ||
      dialogs.some((d) => d.request.requestId.startsWith(REWIND_ID))
    )
      return false
    const picks = agent.messages
      .map((m, index) => ({ m, index }))
      .filter((p): p is { m: UserMessage; index: number } => p.m.role === "user" && !p.m.display?.origin)
      .reverse()
    if (!picks.length) {
      showNote("Nothing to rewind to yet")
      return true
    }
    const labels = picks.map((p, i) => `${i + 1}. ${oneLine(messageText(p.m))}`)
    const request: Extract<DialogRequest, { kind: "select" }> = {
      kind: "select",
      requestId: `${REWIND_ID}${Date.now()}`,
      title: "Rewind the conversation to before which message?",
      options: labels,
      ...(control.fork
        ? { sections: [{ at: 0, choose: "rewind", keys: [{ key: "f", label: "fork from here" }] }] }
        : {}),
    }
    const dialog: Dialog = new Dialog(
      request,
      (answer) => {
        const i = dialogs.indexOf(dialog)
        if (i !== -1) dialogs.splice(i, 1)
        const label =
          typeof answer === "string"
            ? answer
            : answer && typeof answer === "object" && "option" in answer
              ? answer.option
              : undefined
        const fork = answer && typeof answer === "object" && "key" in answer && answer.key === "f"
        const at = label ? labels.indexOf(label) : -1
        if (at !== -1) {
          if (fork) void rewindTo(control, picks[at]!, { fork: true })
          else chooseFileRewind(control, picks[at]!)
        }
        view.requestRender()
      },
      keys,
    )
    dialogs.unshift(dialog)
    view.requestRender()
    return true
  }

  function chooseFileRewind(control: SessionControl, pick: { m: UserMessage; index: number }) {
    if (!control.planRewind) {
      void rewindTo(control, pick, { restoreFiles: false })
      return
    }
    let plan: FileRewindPlan
    try {
      plan = control.planRewind(pick.index)
    } catch (error) {
      view.notice("warning", `Cannot rewind: ${(error as Error).message}`)
      view.requestRender()
      return
    }
    if (plan.conflicts.length) view.notice("warning", `File restore conflicts:\n${plan.conflicts.join("\n")}`)
    const restore =
      plan.owner === "core"
        ? `Restore files too (${plan.restored} restored, ${plan.removed} removed)`
        : plan.owner
    const canRestore = plan.enabled && (plan.owner !== "core" || plan.restored + plan.removed > 0)
    const options = [...(canRestore ? [restore] : []), "Conversation only"]
    const dialog: Dialog = new Dialog(
      {
        kind: "select",
        requestId: `${REWIND_ID}files-${Date.now()}`,
        title: canRestore ? "Restore files too?" : "Rewind conversation; files will not be restored",
        options,
        descriptions: options.map((option) =>
          option === restore
            ? `${plan.conflicts.length ? "Conflicts must be resolved first. " : ""}${plan.note}`
            : `Files will not be restored. ${plan.note}`,
        ),
      },
      (answer) => {
        const at = dialogs.indexOf(dialog)
        if (at !== -1) dialogs.splice(at, 1)
        if (typeof answer === "string")
          void rewindTo(control, pick, { restoreFiles: canRestore && answer === restore, plan })
        view.requestRender()
      },
      keys,
    )
    dialogs.unshift(dialog)
    view.requestRender()
  }

  async function rewindTo(
    control: SessionControl,
    pick: { m: UserMessage; index: number },
    mode: { fork: true } | { restoreFiles: boolean; plan?: FileRewindPlan },
  ) {
    const text = messageText(pick.m)
    try {
      if ("fork" in mode) await control.fork!(pick.index)
      else await control.rewind!(pick.index, { restoreFiles: mode.restoreFiles })
    } catch (err) {
      view.notice("warning", `Cannot rewind: ${err instanceof Error ? err.message : String(err)}`)
      view.requestRender()
      return
    }
    const back = pick.m.content.some((b) => b.type === "image")
      ? messageParts(pick.m)
      : (sentParts.get(userText(pick.m)) ?? [text])
    editor.setParts(editor.isEmpty ? back : [...back, "\n\n", ...editor.getParts()])
    view.notice(
      "info",
      "fork" in mode
        ? "Forked the conversation to before that message, now back in the input."
        : `Rewound the conversation to before that message, now back in the input. ${
            mode.restoreFiles && mode.plan
              ? mode.plan.owner === "core"
                ? `Restored ${mode.plan.restored} file${mode.plan.restored === 1 ? "" : "s"}; removed ${mode.plan.removed} file${mode.plan.removed === 1 ? "" : "s"}.`
                : `${mode.plan.owner} completed.`
              : "Files were not restored."
          }${mode.plan ? ` ${mode.plan.note}` : ""}`,
    )
    redraw()
  }

  function answerDialog(ui: UiRequests, dialog: Dialog, answer: DialogAnswer) {
    const i = dialogs.indexOf(dialog)
    if (i !== -1) dialogs.splice(i, 1)
    termStatus.setWaiting(dialogs.length > 0)
    const { requestId } = dialog.request
    const refused = answer !== undefined && ui.respond(requestId, answer) !== undefined
    if (answer === undefined || refused) ui.cancel(requestId)
    // Esc on an approval denies the call and stops the whole turn, as the dialog's keys say.
    if (answer === undefined && dialog.request.source === "approval" && activity.working) interrupt()
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
    clipboardAbort.abort()
    if (quitting) return
    quitting = true
    commandRunner!.abortAll(new Error("quitting"))
    for (const f of forms.splice(0)) opts.ui?.cancel(f.requestId)
    form?.close()
    closeView()
    off()
    offSwitch?.()
    offCommand?.()
    clearTimeout(hintTimer)
    if (flushTimer) clearTimeout(flushTimer.timer)
    filePicker.dispose()
    ownFiles?.dispose()
    for (const d of dialogs.splice(0)) opts.ui?.cancel(d.request.requestId)
    spinner.stop()
    noticeStrip!.dispose()
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
    // Recalled skills use the same Enter guard as typed ones, without taking the history's arrows.
    if (
      !dialog &&
      !search.active &&
      historyNav.recalling &&
      editor.lineCount === 1 &&
      editor.getText().startsWith("$") &&
      keys.is(e, "popup.accept")
    )
      historyNav.reset()
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
    } else if (keys.is(e, "paste.image") || (e.type === "paste" && !e.text)) {
      void pasteClipboard()
    } else if (e.type === "paste") {
      pasteText(e.text)
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
      cancelClipboard()
      if (commandRunner!.cancel()) {
        // A slash command runs alongside the turn; cancellation leaves the input intact.
      } else if (activity.working) interrupt()
      else if (!editor.isEmpty) editor.clear()
      else return quitOrWarn("cancel")
    } else if (keys.is(e, "exit") && !activity.working && editor.isEmpty) {
      return quitOrWarn("exit")
    } else if (keys.is(e, "copy.reply")) {
      // In both modes: from the session's messages, so a new session (/clear) has none yet.
      const fallback = mode === "fullscreen" ? "Shift+drag selects text." : "Select it with the mouse."
      copyToClipboard(terminal, lastReplyText(agent.messages), "the last reply", showNote, fallback)
    } else if (keys.is(e, "tool-output")) {
      showNote(setDetail(nextDetail(detail)))
    } else if (keys.is(e, "panels.toggle") && panelsShown) {
      panelsCollapsed = !panelsCollapsed
    } else if (keys.is(e, "permissions.mode")) {
      // The user's choice for the whole session tree, sub-agents included; the border shows it.
      const next = agent.permissions.cycleMode()
      showNote(`Permission mode: ${next} — ${MODE_SUMMARY[next]}`)
    } else if (keys.is(e, "help") && editor.isEmpty) {
      // Lists open only on text, so an empty input has none; a dialog took the key above.
      return openKeyReference()
    } else if (editKey(e)) {
      // An editing key of the input (cut, paste back, undo, the external editor).
    } else if (keys.is(e, "interrupt")) {
      // A /compact runs without a turn; interrupt stops it too. Twice in a row: rewind.
      if (!commandRunner!.cancel()) pressInterrupt()
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

  /** The input's editing keys beyond typing: the kill ring, undo and redo, the external editor. */
  function editKey(e: InputEvent): boolean {
    if (keys.is(e, "edit.kill-to-start")) editor.killToLineStart()
    else if (keys.is(e, "edit.kill-to-end")) editor.killToLineEnd()
    else if (keys.is(e, "edit.kill-word")) editor.killWordBefore()
    else if (keys.is(e, "edit.yank")) editor.yank()
    else if (keys.is(e, "edit.undo")) editor.undo()
    else if (keys.is(e, "edit.redo")) editor.redo()
    else if (keys.is(e, "edit.external")) editExternally()
    else return false
    return true
  }

  /**
   * Edits the message in the user's editor ($VISUAL, else $EDITOR; Notepad on Windows, else vi):
   * the terminal is handed over until it exits, then the file's text is the input's.
   */
  function editExternally() {
    if (editor.getParts().some((p) => typeof p !== "string" && "image" in p)) {
      showNote("Remove image attachments before using the external text editor.")
      return
    }
    const command =
      env.VISUAL?.trim() || env.EDITOR?.trim() || (process.platform === "win32" ? "notepad" : "vi")
    const file = join(tmpdir(), `amira-message-${process.pid}-${Date.now()}.md`)
    try {
      writeFileSync(file, editor.getText())
    } catch (err) {
      showNote(`Cannot write the message for the editor: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    let result: ReturnType<typeof spawnSync> | undefined
    let failed: unknown
    try {
      const resume = terminal.suspend?.()
      try {
        result = spawnSync(`${command} "${file}"`, {
          stdio: "inherit",
          shell: true,
          env: { ...process.env, ...env },
        })
      } finally {
        resume?.()
      }
    } catch (err) {
      failed = err
    }
    try {
      if (!result)
        showNote(`Cannot start ${command}: ${failed instanceof Error ? failed.message : String(failed)}`)
      else if (result.error) showNote(`Cannot start ${command}: ${result.error.message}`)
      else if (result.status !== 0)
        showNote(`${command} exited with ${result.status ?? result.signal}; the message is unchanged`)
      else {
        // Editors end the file with a line break the message did not have.
        const text = readFileSync(file, "utf8").replace(/\r\n?/g, "\n").replace(/\n$/, "")
        if (text !== editor.getText()) editor.setText(text)
      }
    } catch (err) {
      showNote(`Cannot read the message back: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      rmSync(file, { force: true })
    }
    view.redraw()
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
      else commandRunner!.run(action.line)
    }
    return true
  }

  /** Applies what the file picker did with a key; false when it left the key to the editor. */
  function handleFileKey(e: InputEvent): boolean {
    const action = filePicker.handleKey(e)
    if (!action) return false
    if (action.type === "insert") {
      const path = action.text
        .slice(1)
        .trim()
        .replace(/^"(.*)"$/, "$1")
      if (!path.endsWith("/") && imageMimeType(path)) {
        try {
          const image = readImage(join(agent.cwd, path))
          if (imageBytes([...editor.getParts(), { image }]) > MAX_IMAGE_BYTES)
            showNote(
              "Images in a message are limited to 5 MB total. Remove an attachment or resize it first.",
            )
          else {
            editor.replaceBeforeCaret(action.replace, "")
            attachImages([image])
          }
        } catch (err) {
          showNote(err instanceof Error ? err.message : String(err))
        }
      } else editor.replaceBeforeCaret(action.replace, action.text)
    }
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
  termStatus.setSessionTitle(agent.session?.title)
  termStatus.start()
  view.banner(
    `${theme.accent("Amira")} ${theme.muted(`· ${modelLabel({ provider: agent.model.provider, model: agent.model.id })} · ${tildePath(agent.cwd, env)}`)}`,
  )
  // Where to start: how to find the commands, the files, the skills and the keys.
  const helpKey = keys.label("help")
  const starts = [
    commands && "/help commands",
    "@ files",
    commands && "$ skills",
    helpKey && `${helpKey} keys`,
  ].filter(Boolean)
  view.banner(theme.muted(starts.join(` ${glyphs.separator} `)))
  if (agent.messages.length) showSession(agent, false)
  for (const e of opts.startupEvents ?? []) onEvent(e)
  // With no provider yet, a welcome card with the steps to a first message says what the
  // notice would.
  const welcome = isNoModel(agent.model) && noProviders()
  if (welcome) view.notice("info", welcomeCard())
  // A notice about something else (a broken settings file, say) still shows under the card.
  if (opts.notice && !(welcome && opts.notice.startsWith("No providers"))) view.notice("warning", opts.notice)
  // The first frame carries the banner, history and startup messages.
  view.start()
  if (opts.initialPrompt?.trim()) submit(opts.initialPrompt)
  if (leftoverInput) reader.feed(leftoverInput)

  return exited
}
