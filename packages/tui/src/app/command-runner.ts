// Owns slash-command execution, cancellation, key help and command echo correlation.
import type { FrontendView, KeyHelp, OwnedConversation, UserMessage } from "@amira/api"
import type { CommandHost } from "@amira/core"
import { type RenderContext, Spinner } from "@amira/tui-kit"
import { userText } from "../format.ts"
import { glyphs } from "../glyphs.ts"
import { ACTIONS, type Action, type Keybindings, type KeySpec, keyLabel } from "../keybindings.ts"
import { activityRow } from "./activity-row.ts"
import { dockKeyHelp } from "./dock.ts"

export interface CommandRunner {
  /** Runs at once, even during a turn; commands that need an idle session say so. */
  run(line: string): Promise<void>
  /**
   * Cancels the newest running slash command (Esc or Ctrl+C, when no dialog has the key): its
   * signal aborts, the input stays as it is. Only the command is stopped: a turn running
   * alongside goes on, and so does a compaction, unless the command cancelled is /compact,
   * whose compaction stops with it as before.
   */
  cancel(): boolean
  /** Returns the key help exposed to a running command's /help context. */
  keyHelp(): KeyHelp[]
  /** True when `prompt` is a message a running command sent with its typed line; its echo is used up. */
  takeEcho(prompt: UserMessage): boolean
  /**
   * A command's message whose display text is the line its echo already shows: only its note
   * (what the command loaded), under the echo as the command's own output would be.
   */
  echoedNote(prompt: UserMessage): void
  /** Drops command echo correlation when the active session changes. */
  clearEchoes(): void
  /** Whether an un-aborted command is available for cancellation. */
  hasCancellable(): boolean
  /** The shared command animation frame, also used by live panels. */
  readonly spinner: string
  /** Demand for the host's shared clock, independent of cancellation availability. */
  readonly animationActive: boolean
  tickAnimation(): void
  render(width: number, ctx: RenderContext, stop?: string): string[]
  /** Aborts all commands during controller shutdown. */
  abortAll(reason: Error): void
}

export interface CommandRunnerOptions {
  commands?: CommandHost
  keys: Keybindings
  reaches: (spec: KeySpec) => boolean
  commandEcho: (line: string) => void
  commandOutput: (level: "info" | "warning" | "error", text: string) => void
  requestRender: () => void
  /** When supplied, the host schedules animation alongside visible dialogs and views. */
  animationChanged?: () => void
  sessionId: () => string
  quit: () => void
  openView: (view: FrontendView) => boolean
  openRewind: () => boolean
  focusConversation?: (conversation: OwnedConversation) => boolean
  unfocusConversation?: () => boolean
  guardCommand?: (line: string) => boolean
  isCompacting: () => boolean
  interrupt: () => void
}

export function createCommandRunner(options: CommandRunnerOptions): CommandRunner {
  /** The slash commands running now, each with the name of the command its line resolved to. */
  const commandAborts = new Map<
    AbortController,
    { name: string | undefined; startedAt: number; sessionId: string }
  >()
  // Separate from the turn spinner: either can finish while the other still runs.
  const spinner = new Spinner()
  let spinning = false
  let animationAt = Date.now()
  const syncAnimation = () => {
    const active = [...commandAborts.keys()].some((controller) => !controller.signal.aborted)
    if (options.animationChanged) {
      if (active && !spinning) animationAt = Date.now()
      spinning = active
      options.animationChanged()
      return
    }
    if (active && !spinning) {
      animationAt = Date.now()
      spinner.start(() => {
        animationAt = Date.now()
        options.requestRender()
      })
    } else if (!active) spinner.stop()
    spinning = active
  }
  /**
   * The message each running command sent with its typed line as display text: the echo shows
   * that line already, so the message is not shown again when its turn starts (or it joins one).
   */
  const commandEchoes = new Map<AbortController, { line: string; text: string }>()

  /** The newest running command that was not cancelled yet; the interrupt key cancels it first. */
  const cancellable = () => [...commandAborts].findLast(([controller]) => !controller.signal.aborted)
  /**
   * The common keys, for /help: the actions with a help line, with their keys as bound now.
   */
  const keyHelp = (): KeyHelp[] => [
    ...(Object.keys(ACTIONS) as Action[]).flatMap((action) => {
      const info: { scope: string; help?: string } = ACTIONS[action]
      if (!info.help) return []
      const label = options.keys.label(action, (spec) => action !== "newline" || options.reaches(spec))
      return label ? [{ keys: label, description: info.help }] : []
    }),
    ...dockKeyHelp(options.keys),
  ]

  return {
    async run(line) {
      const commands = options.commands
      if (!commands || options.guardCommand?.(line)) return
      const echo = commands.shouldEcho(line)
      if (echo) options.commandEcho(line)
      const abort = new AbortController()
      commandAborts.set(abort, {
        name: commands.commandName(line),
        startedAt: Date.now(),
        sessionId: options.sessionId(),
      })
      syncAnimation()
      options.requestRender()
      let sent = false
      await commands
        .run(line, {
          frontend: "tui",
          quit: options.quit,
          openView: options.openView,
          openRewind: options.openRewind,
          focusConversation: options.focusConversation,
          unfocusConversation: options.unfocusConversation,
          keys: keyHelp,
          glyphs: () => ({ separator: glyphs.separator, more: glyphs.more }),
          signal: abort.signal,
          onSend: (text, sendOptions) => {
            if (!echo || sent || sendOptions?.display?.text !== line) return
            commandEchoes.set(abort, { line, text })
            sent = true
            return () => void commandEchoes.delete(abort)
          },
        })
        // A successful send may still be waiting to join a busy turn after its command ends.
        .finally(() => {
          commandAborts.delete(abort)
          syncAnimation()
          options.requestRender()
        })
    },
    cancel() {
      const operation = cancellable()
      if (!operation) return false
      const [abort, command] = operation
      abort.abort(new Error("cancelled"))
      if (command.name === "compact" && options.isCompacting()) options.interrupt()
      syncAnimation()
      options.requestRender()
      return true
    },
    keyHelp,
    takeEcho(prompt) {
      const echoed = [...commandEchoes].find(
        ([, echo]) => prompt.display?.text === echo.line && userText(prompt) === echo.text,
      )
      if (!echoed) return false
      commandEchoes.delete(echoed[0])
      return true
    },
    echoedNote(prompt) {
      if (prompt.display?.note) options.commandOutput("info", prompt.display.note)
    },
    clearEchoes() {
      commandEchoes.clear()
    },
    hasCancellable() {
      return cancellable() !== undefined
    },
    get spinner() {
      return spinning ? spinner.glyph : ""
    },
    get animationActive() {
      return [...commandAborts].some(
        ([controller, entry]) => !controller.signal.aborted && entry.sessionId === options.sessionId(),
      )
    },
    tickAnimation() {
      spinner.tick()
      animationAt = Date.now()
    },
    render(width, ctx, stop) {
      const command = [...commandAborts].findLast(
        ([controller, entry]) => !controller.signal.aborted && entry.sessionId === options.sessionId(),
      )?.[1]
      if (!command) return []
      const elapsed = Date.now() - command.startedAt
      return [
        activityRow(
          {
            label: `/${command.name ?? "command"}`,
            spinner: spinner.glyph,
            turnMs: elapsed,
            tokens: 0,
            rate: 0,
            stop: stop ?? `${options.keys.label("interrupt") ?? keyLabel({ name: "escape" })} stop`,
            animationMs: Math.max(0, animationAt - command.startedAt),
          },
          width,
          ctx,
        ),
      ]
    },
    abortAll(reason) {
      for (const abort of commandAborts.keys()) abort.abort(reason)
      syncAnimation()
    },
  }
}
