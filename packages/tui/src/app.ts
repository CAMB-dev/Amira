import type { AnyEvent } from "@amira/api"
import type { Agent, StatusRegistry } from "@amira/core"
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

/**
 * The interactive terminal UI. Finished messages and tool calls are committed to the
 * scrollback; the live region holds the streaming reply, activity, the editor and the
 * status bar. Resolves with the process exit code when the user quits.
 */
export async function runInteractive(opts: InteractiveOptions): Promise<number> {
  const { agent } = opts
  const theme = opts.theme ?? defaultTheme
  const terminal = opts.terminal ?? new ProcessTerminal()
  if (terminal instanceof ProcessTerminal) terminal.start()
  const { capabilities, leftoverInput } = await (opts.setup ?? setupTerminalInput)(terminal)

  const streaming = new Text()
  const spinner = new Spinner()
  const queued: string[] = []
  let working = false
  let activeTool: string | undefined
  let thinking = false

  const editor = new Editor({ prompt: theme.accent("› "), placeholder: "Message Amira", onSubmit: submit })
  const newlineKey = capabilities.shiftEnter ? "Shift+Enter" : "Ctrl+Enter"
  const root = new Stack([
    streaming,
    new View((width, ctx) => {
      if (!working) return []
      spinner.label = activeTool ? `running ${activeTool}` : thinking ? "thinking" : "working"
      return [...spinner.render(width, ctx), ""]
    }),
    new View((width, ctx) =>
      queued.flatMap((q) => wrapText(ctx.theme.muted(`queued › ${q.replace(/\s+/g, " ")}`), width)),
    ),
    editor,
    new StatusBar(() => opts.status.snapshot()),
    new View((_width, ctx) => [
      ctx.theme.muted(
        `Enter send · ${newlineKey} newline · ${working ? "Esc interrupt · " : ""}Ctrl+C ${working ? "interrupt" : "quit"}`,
      ),
    ]),
  ])
  const renderer = new LiveRenderer(terminal, root, {
    synchronizedOutput: capabilities.synchronizedOutput,
    theme,
  })

  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((r) => {
    resolveExit = r
  })

  const onEvent = (e: AnyEvent) => {
    switch (e.type) {
      case "turn.start":
        working = true
        thinking = false
        spinner.start(() => renderer.requestRender())
        break
      case "message.start":
        thinking = false
        break
      case "message.delta":
        if (e.data.kind === "text") streaming.append(e.data.text)
        else if (e.data.kind === "thinking") thinking = true
        break
      case "message.end": {
        const text = streaming.getText().trim()
        streaming.setText("")
        if (text) renderer.commit([...text.split("\n"), ""])
        break
      }
      case "tool.execute.start":
        activeTool = e.data.name
        break
      case "tool.execute.end": {
        activeTool = undefined
        const args = lastArgs.get(e.data.toolCallId) ?? {}
        renderer.commit(toolLines(theme, e.data.name, args, e.data.result, e.data.durationMs))
        break
      }
      case "turn.end":
        working = false
        activeTool = undefined
        spinner.stop()
        if (e.data.reason === "error") renderer.commit([theme.error(`✗ ${e.data.error ?? "error"}`), ""])
        if (e.data.reason === "aborted") renderer.commit([theme.muted("Interrupted."), ""])
        if (queued.length) {
          const next = queued.splice(0, queued.length).join("\n\n")
          queueMicrotask(() => send(next))
        }
        break
      case "extension.error":
        renderer.commit([theme.warning(`[extension ${e.data.source}] ${e.data.error}`)])
        break
    }
    renderer.requestRender()
  }
  // tool.execute.end does not repeat the arguments; remember them from the start event.
  const lastArgs = new Map<string, Record<string, unknown>>()
  const rememberArgs = (e: AnyEvent) => {
    if (e.type === "tool.execute.start") lastArgs.set(e.data.toolCallId, e.data.args)
    if (e.type === "turn.end") lastArgs.clear()
  }

  function send(text: string) {
    renderer.commit([...userLines(theme, text), ""])
    working = true
    renderer.requestRender()
    agent.prompt(text).catch((err) => {
      renderer.commit([theme.error(`✗ ${err instanceof Error ? err.message : String(err)}`)])
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
    renderer.stop()
    terminal.restore()
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

  const off = agent.bus.subscribe((e) => {
    rememberArgs(e)
    onEvent(e)
  })
  const reader = new InputReader(terminal, onInput)
  reader.start()
  renderer.start()
  renderer.commit([
    `${theme.accent("Amira")} ${theme.muted(`· ${agent.model.provider}/${agent.model.id} · ${agent.cwd}`)}`,
    "",
  ])
  for (const e of opts.startupEvents ?? []) onEvent(e)
  if (leftoverInput) reader.feed(leftoverInput)
  if (opts.initialPrompt?.trim()) send(opts.initialPrompt.trim())

  return exited
}
