import type { AnyEvent, UserMessage } from "@amira/api"
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
  wrapText,
} from "@amira/tui-kit"
import { CommandPopup } from "./command-popup.ts"
import { Dialog, type DialogAnswer } from "./dialog.ts"
import {
  historyLines,
  type SubagentLine,
  subagentLines,
  summarizeArgs,
  toolLines,
  userLines,
} from "./format.ts"
import { InputBox } from "./input-box.ts"
import { StatusBar } from "./status-bar.ts"

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

/** How a user message reads in the transcript. */
function messageText(m: UserMessage): string {
  return m.content.map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`)).join("\n\n")
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
  const queued: string[] = []
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

  const editor = new Editor({ prompt: theme.accent("› "), placeholder: "Message Amira", onSubmit: submit })
  const commands = opts.commands
  const popup = commands ? new CommandPopup(commands, () => renderer.requestRender()) : undefined
  const newlineKey = capabilities.shiftEnter ? "Shift+Enter" : "Ctrl+Enter"
  // Windows Terminal and conhost take Alt+Enter for fullscreen, so Ctrl+Q queues there too.
  const queueKey = process.platform === "win32" ? "Ctrl+Q" : "Alt+Enter"
  const inputBox = new InputBox(editor)
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
      if (popup?.open) {
        return [
          ctx.theme.muted(truncateToWidth("↑↓ select · Tab complete · Enter run · Esc close", width, "…")),
        ]
      }
      const ctrlC = working ? "interrupt" : editor.getText() ? "clear" : "quit"
      const send = working ? `Enter steer · ${queueKey} queue` : "Enter send"
      const esc = working ? "Esc interrupt · " : ""
      const hint = `${send} · ${newlineKey} newline · ${esc}Ctrl+C ${ctrlC}`
      return [ctx.theme.muted(truncateToWidth(hint, width, "…"))]
    }),
  ])
  // The reply streams above the rest and gets the rows it leaves, less one that keeps the line
  // before it in view. Rows past that go to the scrollback as they are finished (StreamText).
  const root = new View((width, ctx) => {
    const rest = bottom.render(width, ctx)
    streaming.maxRows = Math.max(1, ctx.rows - rest.length - 1)
    return [...streaming.render(width, ctx), ...rest]
  })
  const renderer = new LiveRenderer(terminal, root, {
    synchronizedOutput: capabilities.synchronizedOutput,
    theme,
  })

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
        renderer.commit([
          theme.warning(`Budget spent (${e.data.tokens} tokens); sub-agents were stopped.`),
          "",
        ])
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
    // Sub-agents share the bus; only this session's turn events drive the transcript.
    if (e.sessionId !== agent.sessionId && !HOST_EVENTS.has(e.type)) return
    switch (e.type) {
      case "turn.start":
        renderer.commit([...userLines(theme, messageText(e.data.prompt)), ""])
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
          renderer.commit([...rows, ""])
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
        renderer.commit(
          toolLines(theme, e.data.name, args, e.data.result, e.data.durationMs, terminal.columns),
        )
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
        if (e.data.reason === "error") renderer.commit([theme.error(`✗ ${e.data.error ?? "error"}`), ""])
        else if (e.data.reason === "aborted") renderer.commit([theme.muted("Interrupted."), ""])
        else if (!turnShowedOutput) renderer.commit([theme.muted("(no reply)"), ""])
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
        renderer.commit([theme.muted(`Compacted ${e.data.replaced} older messages into a summary.`), ""])
        break
      case "compact.failed":
        compacting = false
        renderer.commit([
          e.data.blocked
            ? theme.muted(`Compaction skipped: ${e.data.error}`)
            : theme.warning(`Compaction failed: ${e.data.error}`),
          "",
        ])
        break
      case "extension.error":
        // Settings warnings travel as extension.error from "settings" but are not extension failures.
        renderer.commit([
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
        if (e.data.state === "injected") renderer.commit([...userLines(theme, text), ""])
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
        const style =
          e.data.level === "error" ? theme.error : e.data.level === "warning" ? theme.warning : theme.text
        renderer.commit([...e.data.text.split("\n").map((l) => style(l)), ""])
        break
      }
    }
    renderer.requestRender()
  }
  // tool.execute.end does not repeat the arguments; remember them from the start event.
  const lastArgs = new Map<string, Record<string, unknown>>()

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
        renderer.commit([theme.error(`✗ ${err instanceof Error ? err.message : String(err)}`), ""])
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
    renderer.commit([theme.muted(`› ${line}`), ""])
    void commands!.run(line, { frontend: "tui", quit: () => quit() }).then(() => renderer.requestRender())
  }

  /** Follows the session a command switched to; a resumed one shows its history. */
  function followAgent(next: Agent) {
    agent = next
    if (next.messages.length) renderer.commit(historyLines(theme, next.messages))
    renderer.requestRender()
  }

  /** Alt+Enter or Ctrl+Q: while a turn runs, queues the message to send after it. */
  function queue() {
    const trimmed = editor.getText().trim()
    if (!trimmed) return
    editor.clear()
    if (working) queued.push(trimmed)
    else send(trimmed)
  }

  function answerDialog(ui: UiRequests, dialog: Dialog, answer: DialogAnswer) {
    const i = dialogs.indexOf(dialog)
    if (i !== -1) dialogs.splice(i, 1)
    const { requestId, title } = dialog.request
    if (answer === undefined || ui.respond(requestId, answer) !== undefined) ui.cancel(requestId)
    const shown =
      answer === undefined ? "cancelled" : answer === true ? "yes" : answer === false ? "no" : answer
    renderer.commit([`${theme.accent("?")} ${title} ${theme.muted(`› ${shown}`)}`, ""])
    renderer.requestRender()
  }

  function quit(code = 0) {
    off()
    offSwitch?.()
    for (const d of dialogs.splice(0)) opts.ui?.cancel(d.request.requestId)
    spinner.stop()
    setBlinking(false)
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
      if (working) agent.abort()
      else if (editor.getText()) editor.clear()
      else return quit()
    } else if (matchesKey(e, "d", { ctrl: true }) && !working && !editor.getText()) {
      return quit()
    } else if (matchesKey(e, "escape")) {
      if (working) agent.abort()
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
  opts.onReady?.()
  const reader = new InputReader(terminal, onInput)
  reader.start()
  renderer.start()
  renderer.commit([
    `${theme.accent("Amira")} ${theme.muted(`· ${agent.model.provider}/${agent.model.id} · ${agent.cwd}`)}`,
    "",
  ])
  if (agent.messages.length) renderer.commit(historyLines(theme, agent.messages))
  for (const e of opts.startupEvents ?? []) onEvent(e)
  if (opts.initialPrompt?.trim()) submit(opts.initialPrompt)
  if (leftoverInput) reader.feed(leftoverInput)

  return exited
}
