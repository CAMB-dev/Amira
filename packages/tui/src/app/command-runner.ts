import type { FrontendView, KeyHelp, UserMessage } from "@amira/api"
import type { CommandHost } from "@amira/core"
import { userText } from "../format.ts"
import { ACTIONS, type Action, type Keybindings, type KeySpec } from "../keybindings.ts"

export interface CommandRunner {
  /** Runs a slash command and tracks it until its promise settles. */
  run(line: string): void
  /** Cancels the newest command that has not already been aborted. */
  cancel(): boolean
  /** Returns the key help exposed to a running command's /help context. */
  keyHelp(): KeyHelp[]
  /** Consumes a command echo when its command sent the matching message. */
  takeEcho(prompt: UserMessage): boolean
  /** Shows the note attached to a command message whose echo is already visible. */
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
  /** The message each running command sent with its typed line as display text. */
  const commandEchoes = new Map<AbortController, { line: string; text: string }>()

  const cancellable = () => [...commandAborts].findLast(([controller]) => !controller.signal.aborted)
  const keyHelp = (): KeyHelp[] =>
    (Object.keys(ACTIONS) as Action[]).flatMap((action) => {
      const info: { scope: string; help?: string } = ACTIONS[action]
      if (!info.help || (info.scope === "transcript" && options.mode !== "fullscreen")) return []
      const label = options.keys.label(action, (spec) => action !== "newline" || options.reaches(spec))
      return label ? [{ keys: label, description: info.help }] : []
    })

  return {
    run(line) {
      const commands = options.commands
      if (!commands) return
      options.commandEcho(line)
      const abort = new AbortController()
      commandAborts.set(abort, commands.commandName(line))
      let sent = false
      void commands
        .run(line, {
          frontend: "tui",
          quit: options.quit,
          openView: options.openView,
          openRewind: options.openRewind,
          keys: keyHelp,
          signal: abort.signal,
          onSend: (text, sendOptions) => {
            if (sent || sendOptions?.display?.text !== line) return
            commandEchoes.set(abort, { line, text })
            sent = true
            return () => void commandEchoes.delete(abort)
          },
        })
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
