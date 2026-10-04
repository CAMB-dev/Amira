import { spawnSync } from "node:child_process"
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isNoModel, type ServerToolBlock } from "@amira/ai"
import { type AnyEvent, type EventMap, modelLabel, type ToolDetailLevel } from "@amira/api"
import { type Agent, MODE_SUMMARY, parseCommandLine } from "@amira/core"
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
import { createNoticeStrip, createOutbox, otherWay, type WhileWorking } from "./app/outbox.ts"
import { OverlayManager } from "./app/overlays.ts"
import { RewindFlow } from "./app/rewind.ts"
import type { InteractiveOptions } from "./app/startup.ts"
import {
  FOLD_PASTES,
  FRAME_MS,
  HINT_NOTE_MS,
  HOST_EVENTS,
  resumeAtStartup,
  tildePath,
  welcomeCard,
} from "./app/startup.ts"
import { interactiveTerminal } from "./app/terminal.ts"
import { copyToClipboard, lastReplyText } from "./clipboard.ts"
import { CommandPopup } from "./command-popup.ts"
import { FileIndex } from "./file-index.ts"
import { FilePicker } from "./file-picker.ts"
import { compactionNotice } from "./format.ts"
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
  const renders = new ReplyRenderers(opts.markdownRenderers, capabilities.background)
  const spinner = new Spinner()
  const activity = createTurnActivity()
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
    const hasImages = editor.getParts().some((p) => typeof p !== "string" && "image" in p)
    const line = editor.lineCount === 1 && !recalled && !hasImages ? editor.getText() : ""
    const commandsPending = popups.map((p) => p.update(line)).find(Boolean)
    const claimed = !hasImages && commands?.inputLine(editor.getText())
    filePicker.update(recalled || claimed ? "" : editor.textBeforeCaret())
    return commandsPending
  }
  // Shift+Enter is no use where the terminal sends it as plain Enter.
  const reaches = (s: KeySpec) => capabilities.shiftEnter || !(s.shift && s.name === "enter")
  const bottomArea = createBottomArea({
    agent: () => agent,
    activity: () => activity,
    view: () => view,
    noticeStrip: () => noticeStrip,
    dialogs: () => overlays.dialogs,
    steering: () => outbox.steering,
    queued: () => outbox.queued,
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

  const mode = env.TERM === "dumb" ? "inline" : (opts.mode ?? settings.mode ?? "inline")
  const overlays = new OverlayManager({
    ui: opts.ui,
    views: opts.views,
    keys,
    theme,
    presenters,
    mode,
    env,
    reaches,
    view: () => view,
    emitWaiting: (data) => agent.bus.emit("ui.waiting", data, { sessionId: "host" }),
    working: () => activity.working,
    interrupt: () => outbox.interrupt(),
    quitting: () => quitting,
  })
  const openView: OverlayManager["openView"] = (v) => overlays.openView(v)

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
    overlay: new View((width, ctx) => overlays.render(width, ctx)),
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
  const view: TranscriptView = mode === "fullscreen" ? createFullscreenView(host) : createInlineView(host)
  const noticeStrip = createNoticeStrip({ theme, requestRender: () => view.requestRender() })
  const outbox = createOutbox({
    agent: () => agent,
    editor,
    activity,
    spinner,
    view,
    takeEcho: (message) => commandRunner.takeEcho(message),
    echoedNote: (message) => commandRunner.echoedNote(message),
    noModelYet,
    canRewind,
    openRewind: () => openRewind(),
    onInterrupt: () => {
      interrupted = true
    },
  })
  const rewind = new RewindFlow({
    agent: () => agent,
    commands,
    dialogs: overlays.dialogs,
    keys,
    editor,
    sentParts: outbox.sentParts,
    working: () => activity.working,
    compacting: () => activity.compacting,
    showNote,
    view,
    redraw,
    waitingChanged: (change) => overlays.waitingChanged(change),
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
    interrupt: () => outbox.interrupt(),
  })

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
    overlays.onEvent(e)
    // Sub-agents share the bus; only this session's turn events drive the transcript.
    if (e.sessionId !== agent.sessionId && !HOST_EVENTS.has(e.type)) return
    switch (e.type) {
      case "turn.start": {
        const prompt = e.data.prompt
        // A turn woken by notices carries every one that was waiting, and takes held ones along.
        noticeStrip.turnStarted(prompt)
        const shown = outbox.turnStarted(prompt)
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
        outbox.clearSteering()
        activity.setRetry(undefined)
        if (e.data.reason === "error") errorNotice(e.data)
        else if (e.data.reason === "aborted") view.notice("interrupted", interruptedText())
        else if (!turnShowedOutput) view.notice("info", "No reply")
        outbox.turnEnded()
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
        // A notice (background sub-agents' results) is not the user's steering. It waits in the
        // bottom area until it joins the conversation (all waiting ones join together), also
        // through an interrupt, after which it goes with the next message.
        if (noticeStrip.steer(e.data.message, e.data.state)) {
          if (e.data.state === "injected") view.user(e.data.message)
          break
        }
        if (outbox.steer(e.data.message, e.data.state)) return redraw()
        break
      }
      case "ui.request":
        overlays.onUiRequest(e.data)
        break
      case "ui.resolved":
        overlays.onUiResolved(e.data)
        break
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
    const message = outbox.prepare(trimmed, parts, display)
    if (!hasImages && commands && parseCommandLine(trimmed)) commandRunner.run(trimmed)
    else if (!hasImages && commands?.skillLine(trimmed)) runSkill(trimmed)
    else if (!hasImages && commands?.inputLine(trimmed)) runInput(trimmed, display)
    else outbox.dispatch(message, parts, how)
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
    outbox.reset()
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

  /** Whether the conversation can be rewound: the host keeps a session file. */
  function canRewind(): boolean {
    return commands?.control.rewind !== undefined
  }

  let quitting = false
  function quit(code = 0) {
    clipboardAbort.abort()
    if (quitting) return
    quitting = true
    commandRunner.abortAll(new Error("quitting"))
    overlays.dispose()
    off()
    offSwitch?.()
    offCommand?.()
    clearTimeout(hintTimer)
    outbox.dispose()
    filePicker.dispose()
    ownFiles?.dispose()
    for (const d of overlays.dialogs.splice(0)) opts.ui?.cancel(d.request.requestId)
    overlays.waitingChanged("resolved")
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
    if (overlays.handleInput(e)) return
    const dialog = overlays.dialogs[0]
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
      } else if (activity.working) outbox.interrupt()
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
      return overlays.openKeyReference()
    } else if (editKey(e)) {
      // An editing key of the input (cut, paste back, undo, the external editor).
    } else if (keys.is(e, "interrupt")) {
      // A /compact runs without a turn; interrupt stops it too. Twice in a row: rewind.
      if (!commandRunner.cancel()) outbox.pressInterrupt()
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
