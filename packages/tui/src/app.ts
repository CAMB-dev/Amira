import { spawnSync } from "node:child_process"
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isNoModel, type ServerToolBlock } from "@amira/ai"
import {
  type AnyEvent,
  type EventMap,
  type FrontendView,
  isSubagentView,
  modelLabel,
  type ToolDetailLevel,
} from "@amira/api"
import { type Agent, AgentBusyError, MODE_SUMMARY, parseCommandLine, type UiRequests } from "@amira/core"
import {
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
  Spinner,
  setupTerminalInput,
  supportsHyperlinks,
  surfaceTheme,
} from "@amira/tui-kit"
import { createTurnActivity, statusRetryLabel } from "./app/activity.ts"
import { createBottomArea } from "./app/bottom-area.ts"
import { createCommandRunner } from "./app/command-runner.ts"
import { externalEditor } from "./app/external-editor.ts"
import {
  createNoticeStrip,
  draftMessage,
  messageParts,
  messageText,
  type Outgoing,
  otherWay,
  outgoing,
  toPrompt,
  type WhileWorking,
} from "./app/outbox.ts"
import { RewindFlow } from "./app/rewind.ts"
import type { InteractiveOptions } from "./app/startup.ts"
import {
  DOUBLE_ESC_MS,
  FOLD_PASTES,
  FRAME_MS,
  HINT_NOTE_MS,
  HOST_EVENTS,
  overlayKeys,
  resumeAtStartup,
  tildePath,
  welcomeCard,
} from "./app/startup.ts"
import { interactiveTerminal } from "./app/terminal.ts"
import { copyToClipboard, lastReplyText } from "./clipboard.ts"
import { CommandPopup } from "./command-popup.ts"
import { Dialog, type DialogAnswer, dialogEchoLines } from "./dialog.ts"
import { ExtensionViewer } from "./extension-view.ts"
import { FileIndex } from "./file-index.ts"
import { FilePicker } from "./file-picker.ts"
import { type FormRequest, FormView, uiFormBackend } from "./form-view.ts"
import { compactionNotice, userText } from "./format.ts"
import { createFullscreenView } from "./fullscreen-view.ts"
import { glyphs } from "./glyphs.ts"
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
import { KeyReference } from "./key-reference.ts"
import { defaultKeys, Keybindings, type KeySpec } from "./keybindings.ts"
import { ReplyRenderers } from "./markdown-nodes.ts"
import { HistoryNavigator, PromptHistory } from "./prompt-history.ts"
import { replyCitations, serverToolCall } from "./server-tools.ts"
import { TerminalStatus } from "./terminal-status.ts"
import { INTERRUPTED_NOTICE, modelErrorNotice } from "./transcript.ts"
import { detailCommand, nextDetail } from "./verbose.ts"
import { type TranscriptView, View, type ViewHost } from "./view.ts"

export type { RetryState } from "./app/activity.ts"
export { activityLabel, lastReasoningLine, retryLabel, statusRetryLabel } from "./app/activity.ts"
export { pendingMessageRows } from "./app/outbox.ts"
export type { InteractiveOptions } from "./app/startup.ts"
export { tildePath } from "./app/startup.ts"

/**
 * The interactive terminal UI. This is its controller: it follows the bus and the keys, keeps
 * the input, dialogs, forms and the message queue, and hands the conversation to a view that
 * draws it inline (finished output goes to the scrollback) or full screen (the conversation
 * is kept and scrolled by Amira). Resolves with the process exit code when the user quits.
 */
export async function runInteractive(opts: InteractiveOptions): Promise<number> {
  let { agent } = opts
  const env = opts.env ?? process.env
  const terminal = interactiveTerminal(opts.terminal, env)
  const presenters = opts.toolRenderers
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
  const termStatus = new TerminalStatus(
    terminal,
    {
      title: settings.title ?? true,
      progress: settings.progress ?? true,
      bell: settings.bell ?? true,
    },
    env,
  )
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
  // Shift+Enter is no use where the terminal sends it as plain Enter.
  const reaches = (s: KeySpec) => capabilities.shiftEnter || !(s.shift && s.name === "enter")
  const bottomArea = createBottomArea({
    agent: () => agent,
    activity: () => activity,
    view: () => view,
    noticeStrip: () => noticeStrip,
    dialogs: () => dialogs,
    steering: () => steering,
    queued: () => queued,
    mode: () => mode,
    hintNote: () => hintNote,
    hasCancellable: () => commandRunner.hasCancellable(),
    canRewind,
    status: opts.status,
    panels: opts.panels,
    editor,
    keys,
    reaches,
    enterDoes,
    spinner,
    search,
    popups,
    filePicker,
  })

  /**
   * An extension's full-screen view, open over the conversation. Inline,
   * the UI is suspended meanwhile: what the main session commits is held and printed when it closes.
   */
  let viewer: ExtensionViewer | KeyReference | undefined
  let viewerTimer: ReturnType<typeof setInterval> | undefined
  /**
   * Forms (ui.form) waiting to be shown full screen, oldest first; the first one is open while
   * `form` is set. A form waits while an inline dialog or the viewer is up, and inline dialogs
   * that arrive while a form is open wait behind it.
   */
  const forms: FormRequest[] = []
  let form: FormView | undefined
  function waitingChanged(change: EventMap["ui.waiting"]["change"]) {
    const pending = dialogs.length + forms.length
    const hidden = pending > 0 && (viewer !== undefined || (form !== undefined && pending > 1))
    agent.bus.emit("ui.waiting", { pending, hidden, change }, { sessionId: "host" })
  }
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
    bottom: bottomArea.layout,
    overlay: new View((width, ctx) => (form ? form.render(width, ctx) : (viewer?.render(width, ctx) ?? []))),
    editorEmpty: () => editor.isEmpty,
    showNote,
    openSubagent: (sessionId: string) => {
      if (!opts.views?.get("subagent")) {
        view.commandOutput("info", "The live sub-agent view is unavailable.")
        view.requestRender()
        return
      }
      openView({ kind: "subagent", data: { sessionId } })
    },
  }
  const mode = env.TERM === "dumb" ? "inline" : (opts.mode ?? settings.mode ?? "inline")
  const view: TranscriptView = mode === "fullscreen" ? createFullscreenView(host) : createInlineView(host)
  const noticeStrip = createNoticeStrip({ theme, requestRender: () => view.requestRender() })
  const rewind = new RewindFlow({
    agent: () => agent,
    commands,
    dialogs,
    keys,
    editor,
    sentParts,
    working: () => activity.working,
    compacting: () => activity.compacting,
    showNote,
    view,
    redraw,
    waitingChanged,
  })
  const openRewind = () => rewind.openRewind()
  const commandRunner = createCommandRunner({
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
    // Keep old command requests working through the same extension lookup.
    if (isSubagentView(v)) v = { ...v, data: { sessionId: v.sessionId } }
    const definition = opts.views?.get(v.kind)
    if (!definition) throw new Error(`there is no "${v.kind}" view`)
    if (quitting || form || env.TERM === "dumb") return false
    if (viewer instanceof ExtensionViewer && viewer.kind === v.kind) viewer.show(v.data, v.state)
    else {
      const next = new ExtensionViewer(definition, v.data, {
        state: v.state,
        waiting: waitingTitles,
        onClose: () => viewer === next && closeView(),
        requestRender: () => next.ready && view.requestOverlayRender(),
        onError: (error) => view.notice("warning", `View ${v.kind}: ${error}`),
        onPrint: (text, level) => {
          view.commandOutput(level ?? "info", text)
          view.requestRender()
        },
        ...(presenters ? { presenters } : {}),
      })
      showOverlay(next)
    }
    if (!(viewer instanceof ExtensionViewer) || viewer.ready) view.renderOverlay()
    return true
  }
  /** Opens the key reference over the conversation (the help key); a form keeps the screen. */
  function openKeyReference() {
    if (form) return
    const next = new KeyReference(keys, {
      fullscreen: mode === "fullscreen",
      onClose: () => viewer === next && closeView(),
      usable: (action, s) => action !== "newline" || reaches(s),
    })
    showOverlay(next)
    view.renderOverlay()
  }

  /** Puts `next` over the conversation, in place of the viewer open there if any. */
  function showOverlay(next: ExtensionViewer | KeyReference) {
    const previous = viewer
    viewer = next
    if (previous instanceof ExtensionViewer) previous.dispose()
    if (viewer !== next) return
    if (next instanceof ExtensionViewer) next.mount()
    if (viewer !== next) return
    view.openOverlay(next instanceof ExtensionViewer && next.declarative)
    if (!viewerTimer) viewerTimer = setInterval(() => view.requestOverlayRender(), 1000)
    waitingChanged("visibility")
  }

  function closeView() {
    const previous = viewer
    if (!previous) return
    viewer = undefined
    clearInterval(viewerTimer)
    viewerTimer = undefined
    view.closeOverlay()
    if (previous instanceof ExtensionViewer) previous.dispose()
    openNextForm()
    waitingChanged("visibility")
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
  }

  /** The open form was answered, cancelled, or resolved elsewhere: back to the conversation. */
  function closeForm(request: FormRequest) {
    const i = forms.indexOf(request)
    if (i !== -1) forms.splice(i, 1)
    if (!form) return
    form = undefined
    view.closeOverlay()
    openNextForm()
    waitingChanged("resolved")
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
    if (viewer instanceof ExtensionViewer || viewer?.handleEvent()) view.requestOverlayRender()
    if (form && (e.type === "ui.request" || e.type === "ui.resolved")) view.requestOverlayRender()
    // Sub-agents share the bus; only this session's turn events drive the transcript.
    if (e.sessionId !== agent.sessionId && !HOST_EVENTS.has(e.type)) return
    switch (e.type) {
      case "turn.start": {
        const prompt = e.data.prompt
        // A turn woken by notices carries every one that was waiting, and takes held ones along.
        noticeStrip.turnStarted(prompt)
        // Messages queued together go as one prompt but read as what they were: one each.
        const merged =
          mergedQueue && messageText(prompt) === mergedQueue.join("\n\n") ? mergedQueue : undefined
        mergedQueue = undefined
        const shown = merged ? merged.map((text) => ({ ...prompt, display: { text } })) : [prompt]
        if (commandRunner.takeEcho(prompt)) commandRunner.echoedNote(prompt)
        else for (const m of shown) view.user(m)
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
        noticeStrip.setRetry(e.ts + e.data.delayMs)
        break
      case "status.changed":
        // A failed model request tried again says so until the stream goes on (or the turn ends).
        activity.setRetrying(statusRetryLabel(e.data as Parameters<typeof statusRetryLabel>[0]))
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
        if (noticeStrip.steer(e.data.message, e.data.state)) {
          if (e.data.state === "injected") view.user(e.data.message)
          break
        }
        if (e.data.state === "queued") {
          steering.push(text)
          break
        }
        const i = steering.indexOf(text)
        if (i !== -1) steering.splice(i, 1)
        const echoed = e.data.state !== "promoted" && commandRunner.takeEcho(e.data.message)
        if (e.data.state === "injected") {
          if (echoed) commandRunner.echoedNote(e.data.message)
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
          waitingChanged("opened")
          break
        }
        const dialog = new Dialog(e.data, (answer) => answerDialog(ui, dialog, answer), keys)
        dialogs.push(dialog)
        // Over the viewer or a form it shows only as a banner; the bell rings so it is noticed.
        waitingChanged("opened")
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
        waitingChanged("resolved")
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
    if (!hasImages && commands && parseCommandLine(trimmed)) commandRunner.run(trimmed)
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
    commandRunner.clearEchoes()
    noticeStrip.reset()
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

  function answerDialog(ui: UiRequests, dialog: Dialog, answer: DialogAnswer) {
    const i = dialogs.indexOf(dialog)
    if (i !== -1) dialogs.splice(i, 1)
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
    waitingChanged("resolved")
  }

  let quitting = false
  function quit(code = 0) {
    clipboardAbort.abort()
    if (quitting) return
    quitting = true
    commandRunner.abortAll(new Error("quitting"))
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
    waitingChanged("resolved")
    spinner.stop()
    noticeStrip.dispose()
    reader.stop()
    view.stop()
    unbindTerminal?.()
    termStatus.stop()
    if (terminal instanceof ProcessTerminal) terminal.stop()
    else terminal.restore()
    resolveExit(code)
  }

  function onInput(e: InputEvent) {
    // Focus reaches extensions even over the viewer.
    if (e.type === "focus") {
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
      for (const k of overlayKeys(e, !form && viewer instanceof ExtensionViewer && viewer.declarative)) {
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
      if (commandRunner.cancel()) {
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
    } else if (keys.is(e, "panels.toggle") && bottomArea.panelsShown) {
      bottomArea.togglePanels()
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
      if (!commandRunner.cancel()) pressInterrupt()
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

  // Edits the message in $VISUAL, $EDITOR, git core.editor, or the platform's default editor.
  // The terminal is handed over until it exits, then the file's text is the input's.
  function editExternally() {
    if (editor.getParts().some((p) => typeof p !== "string" && "image" in p)) {
      showNote("Remove image attachments before using the external text editor.")
      return
    }
    const command = externalEditor(env, agent.cwd)
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
          cwd: agent.cwd,
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
      else commandRunner.run(action.line)
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
  termStatus.start()
  const unbindTerminal = opts.bindTerminal?.(termStatus)
  opts.onReady?.()
  const reader = new InputReader(terminal, onInput)
  reader.start()
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
  if (opts.resumePicker) resumeAtStartup({ run: (line) => commandRunner.run(line), agent: () => agent, quit })
  else if (opts.initialPrompt?.trim()) submit(opts.initialPrompt)
  if (leftoverInput) reader.feed(leftoverInput)

  return exited
}
