import type { FrontendView, KeyHelp, UserMessage } from "@amira/api"
import type { CommandHost } from "@amira/core"
import { userText } from "../format.ts"
import { ACTIONS, type Action, type Keybindings, type KeySpec } from "../keybindings.ts"

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
  /** Aborts all commands during controller shutdown. */
  abortAll(reason: Error): void
}

export interface CommandRunnerOptions {
  commands?: CommandHost
  keys: Keybindings
  mode: "fullscreen" | "inline"
  reaches: (spec: KeySpec) => boolean
  commandEcho: (line: string) => void
  commandOutput: (level: "info" | "warning" | "error", text: string) => void
  requestRender: () => void
  quit: () => void
  openView: (view: FrontendView) => boolean
  openRewind: () => boolean
  isCompacting: () => boolean
  interrupt: () => void
}

export function createCommandRunner(options: CommandRunnerOptions): CommandRunner {
  /** The slash commands running now, each with the name of the command its line resolved to. */
  const commandAborts = new Map<AbortController, string | undefined>()
  /**
   * The message each running command sent with its typed line as display text: the echo shows
   * that line already, so the message is not shown again when its turn starts (or it joins one).
   */
  const commandEchoes = new Map<AbortController, { line: string; text: string }>()

  /** The newest running command that was not cancelled yet; the interrupt key cancels it first. */
  const cancellable = () => [...commandAborts].findLast(([controller]) => !controller.signal.aborted)
  /**
   * The common keys, for /help: the actions with a help line, with their keys as bound now;
   * the transcript's only in full-screen mode, where they work.
   */
  const keyHelp = (): KeyHelp[] =>
    (Object.keys(ACTIONS) as Action[]).flatMap((action) => {
      const info: { scope: string; help?: string } = ACTIONS[action]
      if (!info.help || (info.scope === "transcript" && options.mode !== "fullscreen")) return []
      const label = options.keys.label(action, (spec) => action !== "newline" || options.reaches(spec))
      return label ? [{ keys: label, description: info.help }] : []
    })

  return {
    async run(line) {
      const commands = options.commands
      if (!commands) return
      const echo = commands.shouldEcho(line)
      if (echo) options.commandEcho(line)
      const abort = new AbortController()
      commandAborts.set(abort, commands.commandName(line))
      let sent = false
      await commands
        .run(line, {
          frontend: "tui",
          quit: options.quit,
          openView: options.openView,
          openRewind: options.openRewind,
          keys: keyHelp,
          signal: abort.signal,
          onSend: (text, sendOptions) => {
            if (!echo || sent || sendOptions?.display?.text !== line) return
            commandEchoes.set(abort, { line, text })
            sent = true
            return () => void commandEchoes.delete(abort)
          },
        })
        // A successful send may still be waiting to join a busy turn after its command ends.
        .finally(() => commandAborts.delete(abort))
        .then(() => options.requestRender())
    },
    cancel() {
      const operation = cancellable()
      if (!operation) return false
      const [abort, command] = operation
      abort.abort(new Error("cancelled"))
      if (command === "compact" && options.isCompacting()) options.interrupt()
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
    abortAll(reason) {
      for (const abort of commandAborts.keys()) abort.abort(reason)
    },
  }
}
