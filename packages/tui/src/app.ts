import type { AnyEvent } from "@amira/api"
import { type Agent, AgentBusyError, type StatusRegistry } from "@amira/core"
import {
  type Component,
  defaultTheme,
  Editor,
  type InputEvent,
  InputReader,
  LiveRenderer,
  matchesKey,
  ProcessTerminal,
  type RenderContext,
  type SetupResult,
  Spinner,
  Stack,
  setupTerminalInput,
  type Terminal,
  Text,
  type Theme,
  wrapText,
} from "@amira/tui-kit"
import { toolLines, userLines } from "./format.ts"
import { StatusBar } from "./status-bar.ts"

export interface InteractiveOptions {
  agent: Agent
  status: StatusRegistry
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
const HOST_EVENTS = new Set<string>(["extension.error", "ui.render", "extension.loaded"])

/**
 * The interactive terminal UI. Finished messages and tool calls are committed to the
 * scrollback; the live region holds the streaming reply, activity, the editor and the
 * status bar. Resolves with the process exit code when the user quits.
 */
export async function runInteractive(opts: InteractiveOptions): Promise<number> {
  const { agent } = opts
  const theme = opts.theme ?? defaultTheme
  const terminal = opts.terminal ?? new ProcessTerminal()
  const { capabilities, leftoverInput } = await (opts.setup ?? setupTerminalInput)(terminal)

  const streaming = new Text()
  const spinner = new Spinner()
  const queued: string[] = []
  const running = new Map<string, string>()
  let working = false
  let thinking = false
  /** Whether this message already committed some of its lines early. */
  let streamedEarly = false
  /** Whether the current turn showed anything besides the user's message. */
  let turnShowedOutput = false

  const editor = new Editor({ prompt: theme.accent("› "), placeholder: "Message Amira", onSubmit: submit })
  const newlineKey = capabilities.shiftEnter ? "Shift+Enter" : "Ctrl+Enter"
  const root = new Stack([
    streaming,
    new View((width, ctx) => {
      if (!working) return []
      const tools = [...new Set(running.values())]
      spinner.label = tools.length ? `running ${tools.join(", ")}` : thinking ? "thinking" : "working"
      return [...spinner.render(width, ctx), ""]
    }),
    new View((width, ctx) =>
      queued.flatMap((q) => wrapText(ctx.theme.muted(`queued › ${q.replace(/\s+/g, " ")}`), width)),
    ),
    editor,
    new StatusBar(() => opts.status.snapshot()),
    new View((_width, ctx) => {
      const ctrlC = working ? "interrupt" : editor.getText() ? "clear" : "quit"
      const esc = working ? "Esc interrupt · " : ""
      return [ctx.theme.muted(`Enter send · ${newlineKey} newline · ${esc}Ctrl+C ${ctrlC}`)]
    }),
  ])
  const renderer = new LiveRenderer(terminal, root, {
    synchronizedOutput: capabilities.synchronizedOutput,
    theme,
  })

  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((r) => {
    resolveExit = r
  })

  /**
   * Keeps a long reply readable while it streams: once the complete lines would take
   * more than half the screen, they are committed and only the unfinished tail stays live.
   */
  function commitStreamedLines() {
    const text = streaming.getText()
    const cut = text.lastIndexOf("\n")
    if (cut === -1) return
    const complete = streamedEarly ? text.slice(0, cut) : text.slice(0, cut).replace(/^\n+/, "")
    const rows = wrapText(complete, Math.max(1, terminal.columns)).length
    if (rows <= Math.max(2, Math.floor(terminal.rows / 2))) return
    renderer.commit(complete.split("\n"))
    streaming.setText(text.slice(cut + 1))
    streamedEarly = true
    turnShowedOutput = true
  }

  const onEvent = (e: AnyEvent) => {
    // Sub-agents may share the bus; only this session's turn events drive the UI.
    if (e.sessionId !== agent.sessionId && !HOST_EVENTS.has(e.type)) return
    switch (e.type) {
      case "turn.start":
        working = true
        thinking = false
        turnShowedOutput = false
        spinner.start(() => renderer.requestRender())
        break
      case "message.start":
        thinking = false
        streamedEarly = false
        break
      case "message.delta":
        if (e.data.kind === "text") {
          thinking = false
          streaming.append(e.data.text)
          commitStreamedLines()
        } else if (e.data.kind === "thinking") {
          thinking = true
        }
        break
      case "message.end": {
        const rest = streaming.getText()
        const text = streamedEarly ? rest.trimEnd() : rest.trim()
        streaming.setText("")
        if (text || streamedEarly) {
          renderer.commit([...(text ? text.split("\n") : []), ""])
          turnShowedOutput = true
        }
        streamedEarly = false
        break
      }
      case "tool.execute.start":
        running.set(e.data.toolCallId, e.data.name)
        lastArgs.set(e.data.toolCallId, e.data.args)
        break
      case "tool.execute.end": {
        running.delete(e.data.toolCallId)
        const args = lastArgs.get(e.data.toolCallId) ?? {}
        renderer.commit(
          toolLines(theme, e.data.name, args, e.data.result, e.data.durationMs, terminal.columns),
        )
        turnShowedOutput = true
        break
      }
      case "turn.end":
        working = false
        running.clear()
        lastArgs.clear()
        spinner.stop()
        if (e.data.reason === "error") renderer.commit([theme.error(`✗ ${e.data.error ?? "error"}`), ""])
        else if (e.data.reason === "aborted") renderer.commit([theme.muted("Interrupted."), ""])
        else if (!turnShowedOutput) renderer.commit([theme.muted("(no reply)"), ""])
        if (queued.length) {
          const next = queued.splice(0, queued.length).join("\n\n")
          queueMicrotask(() => send(next))
        }
        break
      case "extension.error":
        renderer.commit([theme.warning(`[extension ${e.data.source}] ${e.data.error}`), ""])
        break
    }
    renderer.requestRender()
  }
  // tool.execute.end does not repeat the arguments; remember them from the start event.
  const lastArgs = new Map<string, Record<string, unknown>>()

  function send(text: string) {
    renderer.commit([...userLines(theme, text), ""])
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

  function submit(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    editor.clear()
    if (working) {
      queued.push(trimmed)
      renderer.requestRender()
      return
    }
    send(trimmed)
  }

  function quit(code = 0) {
    off()
    spinner.stop()
    reader.stop()
    renderer.stop({ clear: true })
    if (terminal instanceof ProcessTerminal) terminal.stop()
    else terminal.restore()
    resolveExit(code)
  }

  function onInput(e: InputEvent) {
    if (matchesKey(e, "c", { ctrl: true })) {
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

  const off = agent.bus.subscribe(onEvent)
  opts.onReady?.()
  const reader = new InputReader(terminal, onInput)
  reader.start()
  renderer.start()
  renderer.commit([
    `${theme.accent("Amira")} ${theme.muted(`· ${agent.model.provider}/${agent.model.id} · ${agent.cwd}`)}`,
    "",
  ])
  for (const e of opts.startupEvents ?? []) onEvent(e)
  if (opts.initialPrompt?.trim()) submit(opts.initialPrompt)
  if (leftoverInput) reader.feed(leftoverInput)

  return exited
}
