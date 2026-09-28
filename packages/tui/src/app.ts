import { statSync } from "node:fs"
import type { AnyEvent, CommandDefinition, ToolDetailLevel, UserMessage } from "@amira/api"
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
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { CommandPopup } from "./command-popup.ts"
import { Dialog, type DialogAnswer } from "./dialog.ts"
import { compactTokens, type SubagentLine, subagentEndLine, subagentLines, userLines } from "./format.ts"
import { glyphs } from "./glyphs.ts"
import { historyLines } from "./history.ts"
import { InputBox } from "./input-box.ts"
import { StatusBar } from "./status-bar.ts"
import { ToolCalls, type TrackedCall } from "./tool-calls.ts"
import {
  callSummary,
  finishedToolLines,
  formatElapsed,
  heldToolLine,
  type PresenterSource,
  runningToolLines,
} from "./tool-view.ts"
import { type BlockKind, commandOutputLines, noticeLines, Transcript } from "./transcript.ts"
import { detailCommand, nextDetail } from "./verbose.ts"

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
  /**
   * Adds the TUI's own slash commands (/verbose) to the registry `commands` runs from; the
   * returned function removes them again when the UI quits.
   */
  registerCommand?: (command: CommandDefinition) => () => void
  /** Presenters of tool calls registered by extensions (D1); unknown tools use a generic one. */
  toolRenderers?: PresenterSource
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

/** How long a note such as "Tool output: full" replaces the key hints. */
const HINT_NOTE_MS = 4000

/** How a user message reads in the transcript. */
function messageText(m: UserMessage): string {
  return m.content.map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`)).join("\n\n")
}

/** Output tokens a streamed text is worth, until the reply's usage says. */
const estimateTokens = (chars: number) => Math.ceil(chars / 4)

/**
 * The interactive terminal UI. Finished messages and tool calls are committed to the
 * scrollback; the live region holds the streaming reply, activity, the editor and the
 * status bar. Resolves with the process exit code when the user quits.
 */
export async function runInteractive(opts: InteractiveOptions): Promise<number> {
  let { agent } = opts
  const theme = opts.theme ?? defaultTheme
  const terminal = opts.terminal ?? new ProcessTerminal()
  const presenters = opts.toolRenderers
  const { capabilities, leftoverInput } = await (opts.setup ?? setupTerminalInput)(terminal)

  const streaming = new StreamText()
  const spinner = new Spinner()
  const transcript = new Transcript()
  const toolCalls = new ToolCalls()
  const queued: string[] = []
  /** Messages steering the running turn that have not reached the model yet. */
  const steering: string[] = []
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
  /** Characters of the reply streaming now: its tokens until its usage arrives. */
  let streamedChars = 0
  /** The user interrupted this turn: the failures of calls it cut short are not the tools'. */
  let interrupted = false
  /** How much of each finished tool call is committed; Ctrl+O and /verbose change it. */
  let detail: ToolDetailLevel = "summary"
  /** A short note shown in place of the key hints, such as the new tool output level. */
  let hintNote: { text: string; until: number } | undefined
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

  /** Commits a whole block, spaced by the transcript's rule. */
  const commitBlock = (kind: BlockKind, lines: string[]) => renderer.commit(transcript.block(kind, lines))

  const editor = new Editor({ prompt: theme.accent("› "), placeholder: "Message Amira", onSubmit: submit })
  const commands = opts.commands
  const popup = commands ? new CommandPopup(commands, () => renderer.requestRender()) : undefined
  const newlineKey = capabilities.shiftEnter ? "Shift+Enter" : "Ctrl+Enter"
  // Windows Terminal and conhost take Alt+Enter for fullscreen, so Ctrl+Q queues there too.
  const queueKey = process.platform === "win32" ? "Ctrl+Q" : "Alt+Enter"
  const inputBox = new InputBox(editor)
  const bottom = new Stack([
    // The activity line: what the turn is doing, how long it has run, the tokens it wrote.
    // Running tools carry their own spinner, so it is left out while they run.
    new View((width, ctx) => {
      if (!working) return []
      const label = compacting
        ? "compacting the conversation"
        : preparing
          ? `preparing ${preparing}`
          : thinking
            ? "thinking"
            : toolCalls.running
              ? ""
              : "working"
      const tokens = turnTokens + estimateTokens(streamedChars)
      const stats = [
        formatElapsed(Date.now() - turnStartedAt),
        ...(tokens ? [`↓ ${compactTokens(tokens)} tokens`] : []),
        "Esc interrupt",
      ].join(" · ")
      const head = label ? `${ctx.theme.accent(spinner.glyph)} ${ctx.theme.muted(`${label} · `)}` : ""
      return [truncateToWidth(head + ctx.theme.muted(stats), width, glyphs.more), ""]
    }),
    new View((width, ctx) => subagentLines([...subagents.values()], Date.now(), width, ctx.theme)),
    new View((width, ctx) => [
      ...steering.flatMap((s) => wrapText(ctx.theme.muted(`steering › ${s.replace(/\s+/g, " ")}`), width)),
      ...queued.flatMap((q) => wrapText(ctx.theme.muted(`queued › ${q.replace(/\s+/g, " ")}`), width)),
    ]),
    new View((width, ctx) => {
      if (dialogs[0] || !popup) return []
      // Synced on every frame, so text set any way (typing, Tab, a dropped steer) is completed.
      popup.update(editor.getText())
      return popup.render(width, ctx)
    }),
    new View((width, ctx) => (dialogs[0] ? dialogs[0].render(width, ctx) : inputBox.render(width, ctx))),
    new StatusBar(() => opts.status.snapshot()),
    new View((width, ctx) => {
      if (dialogs[0]) return []
      if (popup?.visible) {
        return [
          ctx.theme.muted(truncateToWidth("↑↓ select · Tab complete · Enter run · Esc close", width, "…")),
        ]
      }
      if (hintNote && Date.now() < hintNote.until) {
        return [ctx.theme.muted(truncateToWidth(hintNote.text, width, "…"))]
      }
      const ctrlC = working ? "interrupt" : editor.getText() ? "clear" : "quit"
      const send = working ? `Enter steer · ${queueKey} queue` : "Enter send"
      // Esc to interrupt is on the activity line while working.
      const hint = `${send} · ${newlineKey} newline · Ctrl+C ${ctrlC}`
      return [ctx.theme.muted(truncateToWidth(hint, width, "…"))]
    }),
  ])

  /** The tool calls of the step, in call order: running ones with their output, held ones done. */
  function liveToolRows(width: number, ctx: RenderContext): string[] {
    const live = toolCalls.live
    if (!live.length) return []
    const rows: string[] = transcript.gapBefore("tool") ? [""] : []
    const now = Date.now()
    for (const c of live) {
      const presenter = presenters?.get(c.name)
      if (c.end) rows.push(heldToolLine(ctx.theme, presenter, finished(c), width))
      else rows.push(...runningToolLines(ctx.theme, presenter, c, now, spinner.glyph, width))
    }
    return rows
  }

  // The reply streams above the rest and gets the rows it leaves, less one that keeps the line
  // before it in view. Rows past that go to the scrollback as they are finished (StreamText),
  // indented like the committed reply and spaced by the transcript's rule.
  const gutter = glyphs.assistant
  const root = new View((width, ctx) => {
    const rest = bottom.render(width, ctx)
    const tools = liveToolRows(width, ctx)
    streaming.maxRows = Math.max(1, ctx.rows - rest.length - tools.length - 3)
    const commit = ctx.commit
    const replyCtx: RenderContext = commit
      ? {
          ...ctx,
          commit: (rows) =>
            commit(
              transcript.continue(
                "assistant",
                rows.map((r) => gutter + r),
              ),
            ),
        }
      : ctx
    const reply = streaming.render(Math.max(1, width - visibleWidth(gutter)), replyCtx)
    const lead = reply.length && transcript.gapBefore("assistant") ? [""] : []
    return [...lead, ...reply.map((r) => gutter + r), ...tools, "", ...rest]
  })
  const renderer = new LiveRenderer(terminal, root, {
    synchronizedOutput: capabilities.synchronizedOutput,
    theme,
  })

  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((r) => {
    resolveExit = r
  })

  function finished(c: TrackedCall) {
    return {
      name: c.name,
      args: c.args,
      result: c.end!.result,
      durationMs: c.end!.durationMs,
      ...(c.end!.rejected ? { rejected: c.end!.rejected } : {}),
      interrupted,
    }
  }

  function commitCalls(calls: TrackedCall[]) {
    for (const c of calls) {
      const lines = finishedToolLines(theme, presenters?.get(c.name), finished(c), detail, terminal.columns)
      commitBlock("tool", lines)
      turnShowedOutput = true
    }
  }

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
      case "subagent.end": {
        const sub = subagents.get(e.data.childSessionId)
        if (!sub) return false
        subagents.delete(e.data.childSessionId)
        const end = { ...e.data, tokens: sub.tokens }
        commitBlock("tool", [subagentEndLine(sub, end, terminal.columns, theme)])
        break
      }
      case "budget.exceeded":
        commitBlock(
          "notice",
          noticeLines(theme, "warning", `Budget spent (${e.data.tokens} tokens); sub-agents were stopped.`),
        )
        return true
      default: {
        const sub = subagents.get(e.sessionId)
        if (!sub) return false
        if (e.type === "session.start") sub.startedAt ??= e.ts
        else if (e.type === "tool.execute.start") {
          const summary = callSummary(presenters?.get(e.data.name), e.data.args)
          sub.activity = summary ? `${e.data.name} ${summary}` : e.data.name
        } else if (e.type === "message.end") {
          const u = e.data.message.usage
          if (u) sub.tokens += u.input + u.output + u.cacheRead + u.cacheWrite
          const text = e.data.message.content
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("")
            .trim()
          if (text) sub.lastText = text
        }
        return true
      }
    }
    tickSubagents()
    return true
  }

  const onEvent = (e: AnyEvent) => {
    if (trackSubagent(e)) renderer.requestRender()
    // Sub-agents share the bus; only this session's turn events drive the transcript.
    if (e.sessionId !== agent.sessionId && !HOST_EVENTS.has(e.type)) return
    switch (e.type) {
      case "turn.start":
        commitBlock("user", userLines(theme, messageText(e.data.prompt)))
        working = true
        thinking = false
        interrupted = false
        turnShowedOutput = false
        turnStartedAt = Date.now()
        turnTokens = 0
        streamedChars = 0
        spinner.start(() => renderer.requestRender())
        break
      case "message.start":
        thinking = false
        preparing = undefined
        streamedChars = 0
        break
      case "message.delta":
        if (e.data.kind === "text") {
          thinking = false
          streaming.append(e.data.text)
          streamedChars += e.data.text.length
        } else if (e.data.kind === "thinking") {
          thinking = true
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
        // The rows still live are committed as they are shown; earlier ones already were.
        const early = streaming.committedRows > 0
        const rows = streaming.take(Math.max(1, terminal.columns - visibleWidth(gutter)))
        if (rows.length)
          renderer.commit(
            transcript.continue(
              "assistant",
              rows.map((r) => gutter + r),
            ),
          )
        if (rows.length || early) turnShowedOutput = true
        transcript.end()
        const { message } = e.data
        turnTokens += message.usage?.output ?? estimateTokens(streamedChars)
        streamedChars = 0
        toolCalls.expect(message.content.flatMap((b) => (b.type === "toolCall" ? [b.id] : [])))
        break
      }
      case "tool.execute.start":
        preparing = undefined
        toolCalls.start(e.data.toolCallId, e.data.name, e.data.args, Date.now())
        // Draw now: the tool may block the event loop before a scheduled frame would run.
        renderer.render()
        return
      case "tool.execute.update":
        toolCalls.update(e.data.toolCallId, e.data.partial)
        break
      case "tool.execute.end": {
        const { result, durationMs, rejected } = e.data
        commitCalls(
          toolCalls.end(e.data.toolCallId, { result, durationMs, ...(rejected ? { rejected } : {}) }),
        )
        break
      }
      case "turn.end":
        commitCalls(toolCalls.flush())
        working = false
        preparing = undefined
        spinner.stop()
        // Steering the turn never reached becomes the next turn, which shows it again.
        steering.length = 0
        if (e.data.reason === "error")
          commitBlock("notice", noticeLines(theme, "error", e.data.error ?? "error"))
        else if (e.data.reason === "aborted")
          commitBlock("notice", noticeLines(theme, "interrupted", "Interrupted."))
        else if (!turnShowedOutput) commitBlock("notice", noticeLines(theme, "info", "(no reply)"))
        if (queued.length) {
          const next = queued.splice(0, queued.length).join("\n\n")
          queueMicrotask(() => send(next))
        }
        break
      case "compact.start":
        compacting = true
        break
      case "compact.end":
        compacting = false
        commitBlock(
          "notice",
          noticeLines(theme, "success", `Compacted ${e.data.replaced} older messages into a summary.`),
        )
        break
      case "compact.failed":
        compacting = false
        commitBlock(
          "notice",
          e.data.blocked
            ? noticeLines(theme, "info", `Compaction skipped: ${e.data.error}`)
            : noticeLines(theme, "warning", `Compaction failed: ${e.data.error}`),
        )
        break
      case "extension.error":
        // Settings warnings travel as extension.error from "settings" but are not extension failures.
        commitBlock(
          "notice",
          noticeLines(
            theme,
            "warning",
            e.data.source === "settings"
              ? `warning: ${e.data.error}`
              : `[extension ${e.data.source}] ${e.data.error}`,
          ),
        )
        break
      case "turn.steer": {
        const text = messageText(e.data.message)
        if (e.data.state === "queued") {
          steering.push(text)
          break
        }
        const i = steering.indexOf(text)
        if (i !== -1) steering.splice(i, 1)
        if (e.data.state === "injected") commitBlock("user", userLines(theme, text))
        // Put a message the turn dropped back into the editor rather than losing it.
        else if (e.data.state === "dropped")
          editor.setText(editor.getText() ? `${editor.getText()}\n${text}` : text)
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
        const { level, text } = e.data
        // Right after its command it hangs under the echo; on its own it is a notice.
        if (transcript.last === "command" || transcript.last === "command-output") {
          const style = level === "error" ? theme.error : level === "warning" ? theme.warning : theme.text
          commitBlock("command-output", commandOutputLines(style, theme.muted, text))
        } else commitBlock("notice", noticeLines(theme, level, text))
        break
      }
    }
    renderer.requestRender()
  }

  /** The user's message shows up in the transcript on turn.start. */
  function send(text: string) {
    working = true
    renderer.requestRender()
    agent.prompt(text).catch((err) => {
      if (err instanceof AgentBusyError) {
        // A turn we did not know about is running; send this one after it.
        queued.unshift(text)
      } else {
        working = false
        spinner.stop()
        commitBlock("notice", noticeLines(theme, "error", err instanceof Error ? err.message : String(err)))
      }
      renderer.requestRender()
    })
  }

  /** Enter: runs a slash command, sends, or while a turn runs steers it (D29). */
  function submit(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    editor.clear()
    if (commands && parseCommandLine(trimmed)) runCommand(trimmed)
    else if (working) agent.steer(trimmed)
    else send(trimmed)
    renderer.requestRender()
  }

  /** Runs at once, even during a turn; commands that need an idle session say so. */
  function runCommand(line: string) {
    commitBlock("command", [theme.muted(`${glyphs.user} ${line}`)])
    void commands!.run(line, { frontend: "tui", quit: () => quit() }).then(() => renderer.requestRender())
  }

  /** The lines of a session's history, with its id and last write in the separator. */
  function showHistory(a: Agent) {
    let updatedAt: number | undefined
    try {
      if (a.session?.file) updatedAt = statSync(a.session.file).mtimeMs
    } catch {}
    renderer.commit(
      historyLines(theme, a.messages, {
        ...(presenters ? { presenters } : {}),
        width: terminal.columns,
        detail,
        session: { id: a.sessionId, ...(updatedAt !== undefined ? { updatedAt } : {}) },
        transcript,
      }),
    )
  }

  /** Follows the session a command switched to; a resumed one shows its history. */
  function followAgent(next: Agent) {
    agent = next
    toolCalls.flush()
    if (next.messages.length) showHistory(next)
    renderer.requestRender()
  }

  /** Sets how much of later tool results is committed; what is in the scrollback stays. */
  function setDetail(level: ToolDetailLevel): string {
    detail = level
    return `Tool output: ${level} (applies to tool results from now on; Ctrl+O cycles)`
  }

  /** Alt+Enter or Ctrl+Q: while a turn runs, queues the message to send after it. */
  function queue() {
    const trimmed = editor.getText().trim()
    if (!trimmed) return
    editor.clear()
    if (working) queued.push(trimmed)
    else send(trimmed)
  }

  /** Esc or Ctrl+C while working. */
  function interrupt() {
    interrupted = true
    agent.abort()
  }

  function answerDialog(ui: UiRequests, dialog: Dialog, answer: DialogAnswer) {
    const i = dialogs.indexOf(dialog)
    if (i !== -1) dialogs.splice(i, 1)
    const { requestId, title } = dialog.request
    if (answer === undefined || ui.respond(requestId, answer) !== undefined) ui.cancel(requestId)
    const shown =
      answer === undefined ? "cancelled" : answer === true ? "yes" : answer === false ? "no" : answer
    commitBlock("dialog", [`${theme.accent(glyphs.question)} ${title} ${theme.muted(`› ${shown}`)}`])
    renderer.requestRender()
  }

  function quit(code = 0) {
    off()
    offSwitch?.()
    offCommand?.()
    for (const d of dialogs.splice(0)) opts.ui?.cancel(d.request.requestId)
    spinner.stop()
    subagents.clear()
    tickSubagents()
    reader.stop()
    renderer.stop({ clear: true })
    if (terminal instanceof ProcessTerminal) terminal.stop()
    else terminal.restore()
    resolveExit(code)
  }

  function onInput(e: InputEvent) {
    const dialog = dialogs[0]
    // Keys of one input chunk arrive before the next frame; the popup must not answer Enter
    // with candidates for text the editor no longer holds.
    if (!dialog) popup?.update(editor.getText())
    if (dialog) {
      // Ctrl+C closes the dialog like Esc.
      dialog.handleInput(matchesKey(e, "c", { ctrl: true }) ? key("escape") : e)
    } else if (popup?.open && handlePopupKey(e)) {
      // The popup took ↑↓, Tab, Enter or Esc.
    } else if (matchesKey(e, "enter", { alt: true }) || matchesKey(e, "q", { ctrl: true })) {
      queue()
    } else if (matchesKey(e, "c", { ctrl: true })) {
      if (working) interrupt()
      else if (editor.getText()) editor.clear()
      else return quit()
    } else if (matchesKey(e, "d", { ctrl: true }) && !working && !editor.getText()) {
      return quit()
    } else if (matchesKey(e, "o", { ctrl: true })) {
      hintNote = { text: setDetail(nextDetail(detail)), until: Date.now() + HINT_NOTE_MS }
      setTimeout(() => renderer.requestRender(), HINT_NOTE_MS + 10)
    } else if (matchesKey(e, "escape")) {
      if (working) interrupt()
    } else {
      editor.handleInput(e)
    }
    renderer.requestRender()
  }

  /** Applies what the popup did with a key; false when it left the key to the editor. */
  function handlePopupKey(e: InputEvent): boolean {
    const action = popup!.handleKey(e)
    if (!action) return false
    if (action.type === "replace") editor.setText(action.text)
    else if (action.type === "run") {
      editor.clear()
      runCommand(action.line)
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
  renderer.start()
  commitBlock("banner", [
    `${theme.accent("Amira")} ${theme.muted(`· ${agent.model.provider}/${agent.model.id} · ${agent.cwd}`)}`,
  ])
  if (agent.messages.length) showHistory(agent)
  for (const e of opts.startupEvents ?? []) onEvent(e)
  if (opts.initialPrompt?.trim()) submit(opts.initialPrompt)
  if (leftoverInput) reader.feed(leftoverInput)

  return exited
}
