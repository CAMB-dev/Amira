import type { AnyEvent, FrontendView, UserMessage } from "@amira/api"
import {
  type Agent,
  AgentBusyError,
  type CommandHost,
  parseCommandLine,
  type StatusRegistry,
  type UiRequests,
} from "@amira/core"
import {
  type Component,
  defaultTheme,
  Editor,
  type EditorPart,
  FullScreenRenderer,
  type InputEvent,
  InputReader,
  key,
  LiveRenderer,
  matchesKey,
  ProcessTerminal,
  type RenderContext,
  type SetupResult,
  Spinner,
  Stack,
  StreamText,
  setupTerminalInput,
  type Terminal,
  type Theme,
  truncateToWidth,
  wrapText,
} from "@amira/tui-kit"
import { CommandPopup } from "./command-popup.ts"
import { Dialog, type DialogAnswer } from "./dialog.ts"
import { FileIndex, type FileSource } from "./file-index.ts"
import { FilePicker } from "./file-picker.ts"
import {
  historyLines,
  type SubagentLine,
  subagentLines,
  summarizeArgs,
  toolLines,
  userLines,
  userText,
} from "./format.ts"
import { HistorySearch } from "./history-search.ts"
import { InputBox } from "./input-box.ts"
import { HistoryNavigator, PromptHistory } from "./prompt-history.ts"
import { StatusBar } from "./status-bar.ts"
import { SubagentViewer } from "./subagent-view.ts"

export interface InteractiveOptions {
  agent: Agent
  status: StatusRegistry
  /** Extension dialogs, answered inline. Without it they are left to other frontends. */
  ui?: UiRequests
  /**
   * Slash commands and their completion popup. It owns the active session: the UI follows
   * the agent it switches to (/clear, /resume).
   */
  commands?: CommandHost
  /** Events emitted before the UI subscribed, such as extension load errors. */
  startupEvents?: AnyEvent[]
  /** Sent as the first message once the UI is up. */
  initialPrompt?: string
  /** Called once the UI listens to the bus, e.g. to announce the session. */
  onReady?: () => void
  terminal?: Terminal
  /** Terminal setup; injectable for tests. Defaults to probing the real terminal. */
  setup?: (terminal: Terminal) => Promise<SetupResult>
  theme?: Theme
  /**
   * Prompts sent before, for ↑/↓ and Ctrl+R; the CLI passes the project's persisted history.
   * Default: one kept in memory for this run.
   */
  history?: PromptHistory
  /** The files the @ picker offers. Default: the working directory's, from git or a walk. */
  files?: FileSource
}

/** The renderer's shortest time between frames, and how long a key waits for async candidates. */
const FRAME_MS = 16

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

/** A component that draws a function's lines; handy for small pieces of view state. */
class View implements Component {
  constructor(private draw: (width: number, ctx: RenderContext) => string[]) {}
  render(width: number, ctx: RenderContext): string[] {
    return this.draw(width, ctx)
  }
}

/** Events without a turn that the UI shows whatever session emitted them. */
const HOST_EVENTS = new Set<string>([
  "extension.error",
  "ui.render",
  "extension.loaded",
  "ui.request",
  "ui.resolved",
  "command.output",
])

/**
 * How a user message reads while queued, or back in the editor once dropped: its display text,
 * if any. That is what the user typed (e.g. "/review-pr 123"), so sending it again re-runs it.
 */
function messageText(m: UserMessage): string {
  return m.display?.text.trim() || userText(m)
}

/**
 * The interactive terminal UI. Finished messages and tool calls are committed to the
 * scrollback; the live region holds the streaming reply, activity, the editor and the
 * status bar. Resolves with the process exit code when the user quits.
 */
export async function runInteractive(opts: InteractiveOptions): Promise<number> {
  let { agent } = opts
  const theme = opts.theme ?? defaultTheme
  const terminal = opts.terminal ?? new ProcessTerminal()
  const { capabilities, leftoverInput } = await (opts.setup ?? setupTerminalInput)(terminal)

  const streaming = new StreamText()
  const spinner = new Spinner()
  const queued: Outgoing[] = []
  /** Content of recent messages with folded pastes, by their text, so a dropped steer comes back folded. */
  const sentParts = new Map<string, EditorPart[]>()
  /** Messages steering the running turn that have not reached the model yet. */
  const steering: string[] = []
  /** Open extension dialogs; the first one has the keyboard. */
  const dialogs: Dialog[] = []
  const running = new Map<string, string>()
  let working = false
  let thinking = false
  let compacting = false
  /** Blink state of the bullet in front of running tools. */
  let blinkOn = true
  let blinkTimer: ReturnType<typeof setInterval> | undefined
  const setBlinking = (on: boolean) => {
    if (on && !blinkTimer) {
      blinkOn = true
      blinkTimer = setInterval(() => {
        blinkOn = !blinkOn
        renderer.requestRender()
      }, 1000)
    } else if (!on && blinkTimer) {
      clearInterval(blinkTimer)
      blinkTimer = undefined
    }
  }
  /** Tool the model is currently writing a call for, before it runs. */
  let preparing: string | undefined
  /** Whether the current turn showed anything besides the user's message. */
  let turnShowedOutput = false
  /** This session's sub-agents (and theirs) that are queued or running, in start order. */
  const subagents = new Map<string, SubagentLine>()
  /** Redraws once a second while sub-agents run, so their elapsed time moves. */
  let subagentTimer: ReturnType<typeof setInterval> | undefined
  const tickSubagents = () => {
    if (subagents.size && !subagentTimer) subagentTimer = setInterval(() => renderer.requestRender(), 1000)
    else if (!subagents.size && subagentTimer) {
      clearInterval(subagentTimer)
      subagentTimer = undefined
    }
  }

  const editor = new Editor({
    prompt: theme.accent("› "),
    placeholder: "Message Amira",
    onSubmit: (text, info) => submit(text, info.parts, info.display),
    foldPastes: FOLD_PASTES,
  })
  const commands = opts.commands
  const popup = commands ? new CommandPopup(commands, () => renderer.requestRender()) : undefined
  const history = opts.history ?? new PromptHistory()
  const historyNav = new HistoryNavigator(history, editor)
  const search = new HistorySearch(history, editor)
  const filePicker = new FilePicker(opts.files ?? new FileIndex(agent.cwd), () => renderer.requestRender())
  /**
   * Tells the completion lists what the editor holds; a promise while candidates are on their
   * way. Cheap on any text: the command popup only looks at a single line, the file picker at
   * the caret's line up to the caret.
   */
  const syncCompletions = (): Promise<void> | undefined => {
    const commandsPending = popup?.update(editor.lineCount === 1 ? editor.getText() : "")
    const filesPending = filePicker.update(editor.textBeforeCaret())
    return commandsPending ?? filesPending
  }
  /** The list shown below the input box, if any, with its key hint. */
  const inputList = ():
    | { lines: (width: number, ctx: RenderContext) => string[]; hint: string }
    | undefined => {
    if (search.active) {
      return {
        lines: (w, ctx) => search.render(w, ctx),
        hint: "Enter accept · Ctrl+R older · Ctrl+S newer · Esc cancel",
      }
    }
    if (popup?.visible) {
      return {
        lines: (w, ctx) => popup.render(w, ctx),
        hint: "↑↓ select · Tab complete · Enter run · Esc close",
      }
    }
    if (filePicker.visible) {
      return {
        lines: (w, ctx) => filePicker.render(w, ctx),
        hint: "↑↓ select · Tab/Enter insert · Esc close",
      }
    }
    return undefined
  }
  const newlineKey = capabilities.shiftEnter ? "Shift+Enter" : "Ctrl+Enter"
  // Windows Terminal and conhost take Alt+Enter for fullscreen, so Ctrl+Q queues there too.
  const queueKey = process.platform === "win32" ? "Ctrl+Q" : "Alt+Enter"
  const inputBox = new InputBox(editor)
  const statusBar = new StatusBar(() => opts.status.snapshot())
  /**
   * Lines to print above the live region, sent with the next frame: running a command commits
   * its echo and then each thing it prints, and a redraw for each of those flickered.
   */
  const pendingCommits: string[] = []
  const commit = (lines: string[]) => {
    pendingCommits.push(...lines)
    renderer.requestRender()
  }
  const bottom = new Stack([
    new View((width, ctx) => {
      if (!working) return []
      // A running tool shows as its own line with a blinking bullet, like the line it becomes.
      if (running.size) {
        const bullet = blinkOn ? ctx.theme.accent("●") : ctx.theme.muted("●")
        const lines = [...running.entries()].map(([id, name]) => {
          const summary = summarizeArgs(lastArgs.get(id) ?? {})
          return truncateToWidth(
            `${bullet} ${ctx.theme.accent(name)}${summary ? ` ${summary}` : ""}`,
            width,
            "…",
          )
        })
        // Plus a spinner underneath, so it is obvious that work is going on.
        spinner.label = `running ${[...new Set(running.values())].join(", ")}`
        return [...lines, ...spinner.render(width, ctx), ""]
      }
      spinner.label = compacting
        ? "compacting the conversation"
        : preparing
          ? `preparing ${preparing}`
          : thinking
            ? "thinking"
            : "working"
      return [...spinner.render(width, ctx), ""]
    }),
    new View((width, ctx) => subagentLines([...subagents.values()], Date.now(), width, ctx.theme)),
    new View((width, ctx) => [
      ...steering.flatMap((s) => wrapText(ctx.theme.muted(`steering › ${s.replace(/\s+/g, " ")}`), width)),
      ...queued.flatMap((q) =>
        wrapText(ctx.theme.muted(`queued › ${(q.display ?? q.text).replace(/\s+/g, " ")}`), width),
      ),
    ]),
    new View((width, ctx) => (dialogs[0] ? dialogs[0].render(width, ctx) : inputBox.render(width, ctx))),
    // The command list, file list or history search opens below the input box, in place of the
    // status bar and the hint, so the box stays where it is while the list changes with each key.
    new View((width, ctx) => {
      const list = dialogs[0] ? undefined : inputList()
      if (!list) return statusBar.render(width, ctx)
      return [...list.lines(width, ctx), ctx.theme.muted(truncateToWidth(list.hint, width, "…"))]
    }),
    new View((width, ctx) => {
      if (dialogs[0] || inputList()) return []
      const ctrlC = working ? "interrupt" : editor.isEmpty ? "quit" : "clear"
      const send = working ? `Enter steer · ${queueKey} queue` : "Enter send"
      const esc = working || compacting ? "Esc interrupt · " : ""
      const hint = `${send} · ${newlineKey} newline · ${esc}Ctrl+C ${ctrlC}`
      return [ctx.theme.muted(truncateToWidth(hint, width, "…"))]
    }),
  ])
  // The reply streams above the rest and gets the rows it leaves, less one that keeps the line
  // before it in view. Rows past that go to the scrollback as they are finished (StreamText).
  const root = new View((width, ctx) => {
    // Lines committed since the last frame go out with this one: one redraw, not one each.
    if (pendingCommits.length) ctx.commit?.(pendingCommits.splice(0))
    const rest = bottom.render(width, ctx)
    streaming.maxRows = Math.max(1, ctx.rows - rest.length - 1)
    return [...streaming.render(width, ctx), ...rest]
  })
  const renderer = new LiveRenderer(terminal, root, {
    synchronizedOutput: capabilities.synchronizedOutput,
    frameIntervalMs: FRAME_MS,
    theme,
  })

  /**
   * The full-screen sub-agent viewer, on the alternate screen while open. The inline UI is
   * suspended meanwhile: what the main session commits is held and printed when it closes.
   */
  let viewer: SubagentViewer | undefined
  let viewerTimer: ReturnType<typeof setInterval> | undefined
  const fullScreen = new FullScreenRenderer(
    terminal,
    new View((width, ctx) => viewer?.render(width, ctx) ?? []),
    { synchronizedOutput: capabilities.synchronizedOutput, theme, frameIntervalMs: 33 },
  )

  function openView(view: FrontendView) {
    if (view.kind !== "subagent" || !commands) return
    if (viewer) viewer.show(view.sessionId)
    else {
      viewer = new SubagentViewer(view.sessionId, {
        source: commands.control,
        waiting: () => dialogs.map((d) => d.request.title),
        onClose: closeView,
      })
      renderer.suspend()
      fullScreen.open()
      // Elapsed times move even when no event comes.
      viewerTimer = setInterval(() => fullScreen.requestRender(), 1000)
    }
    fullScreen.render()
  }

  function closeView() {
    if (!viewer) return
    viewer = undefined
    clearInterval(viewerTimer)
    viewerTimer = undefined
    fullScreen.close()
    renderer.resume()
  }

  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((r) => {
    resolveExit = r
  })

  /** Keeps the sub-agent lines current; true when the event was about a sub-agent. */
  function trackSubagent(e: AnyEvent): boolean {
    const mine = e.sessionId === agent.sessionId || subagents.has(e.sessionId)
    switch (e.type) {
      case "subagent.start":
        if (!mine) return false
        subagents.set(e.data.childSessionId, {
          role: e.data.role ?? "agent",
          task: e.data.prompt,
          depth: e.data.depth,
          tokens: 0,
          ...(e.data.queued ? {} : { startedAt: e.ts }),
        })
        break
      case "subagent.end":
        if (!subagents.delete(e.data.childSessionId)) return false
        break
      case "budget.exceeded":
        commit([theme.warning(`Budget spent (${e.data.tokens} tokens); sub-agents were stopped.`), ""])
        return true
      default: {
        const sub = subagents.get(e.sessionId)
        if (!sub) return false
        if (e.type === "session.start") sub.startedAt ??= e.ts
        else if (e.type === "message.end" && e.data.message.usage) {
          const u = e.data.message.usage
          sub.tokens += u.input + u.output + u.cacheRead + u.cacheWrite
        }
        return true
      }
    }
    tickSubagents()
    return true
  }

  const onEvent = (e: AnyEvent) => {
    if (trackSubagent(e)) renderer.requestRender()
    if (viewer?.handleEvent(e)) fullScreen.requestRender()
    // A dialog of the main session shows as a banner in the viewer; ring once so it is noticed.
    if (viewer && e.type === "ui.request" && opts.ui) terminal.write("\x07")
    // Sub-agents share the bus; only this session's turn events drive the transcript.
    if (e.sessionId !== agent.sessionId && !HOST_EVENTS.has(e.type)) return
    switch (e.type) {
      case "turn.start":
        commit([...userLines(theme, e.data.prompt), ""])
        working = true
        thinking = false
        turnShowedOutput = false
        spinner.start(() => renderer.requestRender())
        break
      case "message.start":
        thinking = false
        preparing = undefined
        break
      case "message.delta":
        if (e.data.kind === "text") {
          thinking = false
          streaming.append(e.data.text)
        } else if (e.data.kind === "thinking") {
          thinking = true
        } else if (e.data.name) {
          thinking = false
          preparing = e.data.name
        }
        break
      case "message.end": {
        // The rows still live are committed as they are shown; earlier ones already were.
        const early = streaming.committedRows > 0
        const rows = streaming.take(terminal.columns)
        if (rows.length || early) {
          commit([...rows, ""])
          turnShowedOutput = true
        }
        break
      }
      case "tool.execute.start":
        preparing = undefined
        running.set(e.data.toolCallId, e.data.name)
        lastArgs.set(e.data.toolCallId, e.data.args)
        setBlinking(true)
        // Draw now: the tool may block the event loop before a scheduled frame would run.
        renderer.render()
        return
      case "tool.execute.end": {
        running.delete(e.data.toolCallId)
        if (!running.size) setBlinking(false)
        const args = lastArgs.get(e.data.toolCallId) ?? {}
        commit(toolLines(theme, e.data.name, args, e.data.result, e.data.durationMs, terminal.columns))
        turnShowedOutput = true
        break
      }
      case "turn.end":
        working = false
        preparing = undefined
        running.clear()
        setBlinking(false)
        lastArgs.clear()
        spinner.stop()
        // Steering the turn never reached becomes the next turn, which shows it again.
        steering.length = 0
        if (e.data.reason === "error") commit([theme.error(`✗ ${e.data.error ?? "error"}`), ""])
        else if (e.data.reason === "aborted") commit([theme.muted("Interrupted."), ""])
        else if (!turnShowedOutput) commit([theme.muted("(no reply)"), ""])
        if (queued.length) {
          const next = queued.splice(0, queued.length)
          const text = next.map((q) => q.text).join("\n\n")
          const display = next.some((q) => q.display)
            ? next.map((q) => q.display ?? q.text).join("\n\n")
            : undefined
          queueMicrotask(() => send(outgoing(text, display)))
        }
        break
      case "compact.start":
        compacting = true
        break
      case "compact.end":
        compacting = false
        commit([theme.muted(`Compacted ${e.data.replaced} older messages into a summary.`), ""])
        break
      case "compact.failed":
        compacting = false
        commit([
          e.data.blocked
            ? theme.muted(`Compaction skipped: ${e.data.error}`)
            : theme.warning(`Compaction failed: ${e.data.error}`),
          "",
        ])
        break
      case "extension.error":
        // Settings warnings travel as extension.error from "settings" but are not extension failures.
        commit([
          theme.warning(
            e.data.source === "settings"
              ? `warning: ${e.data.error}`
              : `[extension ${e.data.source}] ${e.data.error}`,
          ),
          "",
        ])
        break
      case "turn.steer": {
        const text = messageText(e.data.message)
        if (e.data.state === "queued") {
          steering.push(text)
          break
        }
        const i = steering.indexOf(text)
        if (i !== -1) steering.splice(i, 1)
        if (e.data.state === "injected") commit([...userLines(theme, e.data.message), ""])
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
        const dialog = new Dialog(e.data, (answer) => answerDialog(ui, dialog, answer))
        dialogs.push(dialog)
        break
      }
      case "ui.resolved": {
        const i = dialogs.findIndex((d) => d.request.requestId === e.data.requestId)
        if (i !== -1) dialogs.splice(i, 1)
        break
      }
      case "command.output": {
        const style =
          e.data.level === "error" ? theme.error : e.data.level === "warning" ? theme.warning : theme.text
        commit([...e.data.text.split("\n").map((l) => style(l)), ""])
        break
      }
    }
    renderer.requestRender()
  }
  // tool.execute.end does not repeat the arguments; remember them from the start event.
  const lastArgs = new Map<string, Record<string, unknown>>()

  /** The user's message shows up in the transcript on turn.start. */
  function send(message: Outgoing) {
    working = true
    renderer.requestRender()
    agent.prompt(toPrompt(message)).catch((err) => {
      if (err instanceof AgentBusyError) {
        // A turn we did not know about is running; send this one after it.
        queued.unshift(message)
      } else {
        working = false
        spinner.stop()
        commit([theme.error(`✗ ${err instanceof Error ? err.message : String(err)}`), ""])
      }
      renderer.requestRender()
    })
  }

  /**
   * Enter: runs a slash command, sends, or while a turn runs steers it (D29). `parts` is the
   * editor content as typed, folded pastes apart, for the prompt history; `display` shows the
   * pastes as their placeholders in the transcript.
   */
  function submit(text: string, parts: EditorPart[] = [text], display?: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    editor.clear()
    history.add(parts)
    historyNav.reset()
    const message = outgoing(trimmed, display)
    remember(message, parts)
    if (commands && parseCommandLine(trimmed)) runCommand(trimmed)
    else if (working) agent.steer(toPrompt(message))
    else send(message)
    renderer.requestRender()
  }

  /** Runs at once, even during a turn; commands that need an idle session say so. */
  function runCommand(line: string) {
    commit([theme.muted(`› ${line}`), ""])
    void commands!
      .run(line, { frontend: "tui", quit: () => quit(), openView })
      .then(() => renderer.requestRender())
  }

  /** Follows the session a command switched to; a resumed one shows its history. */
  function followAgent(next: Agent) {
    agent = next
    if (next.messages.length) commit(historyLines(theme, next.messages))
    renderer.requestRender()
  }

  /** Alt+Enter or Ctrl+Q: while a turn runs, queues the message to send after it. */
  function queue() {
    const trimmed = editor.getText().trim()
    if (!trimmed) return
    const parts = editor.getParts()
    const message = outgoing(trimmed, editor.getDisplayText())
    history.add(parts)
    historyNav.reset()
    remember(message, parts)
    editor.clear()
    if (working) queued.push(message)
    else send(message)
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

  function answerDialog(ui: UiRequests, dialog: Dialog, answer: DialogAnswer) {
    const i = dialogs.indexOf(dialog)
    if (i !== -1) dialogs.splice(i, 1)
    const { requestId, title } = dialog.request
    if (answer === undefined || ui.respond(requestId, answer) !== undefined) ui.cancel(requestId)
    const shown =
      answer === undefined ? "cancelled" : answer === true ? "yes" : answer === false ? "no" : answer
    commit([`${theme.accent("?")} ${title} ${theme.muted(`› ${shown}`)}`, ""])
    renderer.requestRender()
  }

  function quit(code = 0) {
    closeView()
    off()
    offSwitch?.()
    for (const d of dialogs.splice(0)) opts.ui?.cancel(d.request.requestId)
    spinner.stop()
    setBlinking(false)
    subagents.clear()
    tickSubagents()
    reader.stop()
    // What was committed but not drawn yet still belongs in the scrollback.
    if (pendingCommits.length) renderer.render()
    renderer.stop({ clear: true })
    if (terminal instanceof ProcessTerminal) terminal.stop()
    else terminal.restore()
    resolveExit(code)
  }

  function onInput(e: InputEvent) {
    // The viewer owns the keyboard while it is open.
    if (viewer) {
      viewer.handleInput(e)
      fullScreen.requestRender()
      return
    }
    const dialog = dialogs[0]
    // Keys of one input chunk arrive before the next frame; the popup must not answer Enter
    // with candidates for text the editor no longer holds.
    if (!dialog && !search.active) syncCompletions()
    if (dialog) {
      // Ctrl+C closes the dialog like Esc.
      dialog.handleInput(matchesKey(e, "c", { ctrl: true }) ? key("escape") : e)
    } else if (search.active) {
      // Keys like the arrows end the search and then do what they do.
      if (search.handleKey(e) === "accepted-pass") return onInput(e)
    } else if (popup?.open && handlePopupKey(e)) {
      // The popup took ↑↓, Tab, Enter or Esc.
    } else if (filePicker.open && handleFileKey(e)) {
      // The file picker took ↑↓, Tab, Enter or Esc.
    } else if (matchesKey(e, "r", { ctrl: true })) {
      search.start()
    } else if (
      (matchesKey(e, "up") || matchesKey(e, "down")) &&
      historyNav.move(matchesKey(e, "up") ? -1 : 1)
    ) {
      // ↑↓ walked the prompt history.
    } else if (matchesKey(e, "enter", { alt: true }) || matchesKey(e, "q", { ctrl: true })) {
      queue()
    } else if (matchesKey(e, "c", { ctrl: true })) {
      if (working) agent.abort()
      else if (!editor.isEmpty) editor.clear()
      else return quit()
    } else if (matchesKey(e, "d", { ctrl: true }) && !working && editor.isEmpty) {
      return quit()
    } else if (matchesKey(e, "escape")) {
      // A /compact runs without a turn; Esc stops it too.
      if (working || compacting) agent.abort()
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
    if (pending) setTimeout(() => renderer.requestRender(), FRAME_MS)
    else renderer.requestRender()
  }

  /** Applies what the popup did with a key; false when it left the key to the editor. */
  function handlePopupKey(e: InputEvent): boolean {
    const action = popup!.handleKey(e)
    if (!action) return false
    if (action.type === "replace") editor.setText(action.text)
    else if (action.type === "run") {
      history.add([action.line])
      historyNav.reset()
      editor.clear()
      runCommand(action.line)
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
  opts.onReady?.()
  const reader = new InputReader(terminal, onInput)
  reader.start()
  commit([
    `${theme.accent("Amira")} ${theme.muted(`· ${agent.model.provider}/${agent.model.id} · ${agent.cwd}`)}`,
    "",
  ])
  if (agent.messages.length) commit(historyLines(theme, agent.messages))
  for (const e of opts.startupEvents ?? []) onEvent(e)
  // The first frame carries the banner, history and startup messages.
  renderer.start()
  if (opts.initialPrompt?.trim()) submit(opts.initialPrompt)
  if (leftoverInput) reader.feed(leftoverInput)

  return exited
}
