import type { TerminalApi, TerminalProgress } from "@amira/api"
import { DEFAULT_TUI_BELL, DEFAULT_TUI_NOTIFY, DEFAULT_TUI_PROGRESS, DEFAULT_TUI_TITLE } from "@amira/api"
import {
  focusReporting,
  osc,
  progressSupported,
  type Terminal,
  type TerminalMode,
  truncateToWidth,
} from "@amira/tui-kit"
import { displayTitle } from "./title.ts"

export interface TerminalStatusOptions {
  title?: boolean
  progress?: boolean
  bell?: boolean
  notify?: "auto" | "off"
}

/** No guessed OSCs: Windows Terminal has BEL/taskbar alerts, not desktop notifications. */
function notification(env: Record<string, string | undefined>, text: string): string {
  if (env.TERM === "dumb" || env.TMUX || env.STY) return ""
  if (env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "ghostty") return `\x1b]9;${text}\x1b\\`
  if (env.TERM_PROGRAM === "WezTerm") return `\x1b]777;notify;Amira;${text}\x1b\\`
  if (env.TERM === "xterm-kitty" || env.TERM_PROGRAM === "kitty" || env.KITTY_WINDOW_ID)
    return `\x1b]99;;${text}\x1b\\`
  return ""
}

/** Coalesces structured effects at a microtask boundary, outside synchronous frame writes. */
export class TerminalStatus implements TerminalApi {
  #started = false
  #pending = false
  #title: string | undefined
  #progress: TerminalProgress | undefined
  #ringPending = false
  #running = false
  #focused: boolean | undefined
  #dialogWaiting = false
  #attention = false
  #completed = false
  #acknowledged = false
  #alerted = false
  #titleAt = -Infinity
  #titleTimer: ReturnType<typeof setTimeout> | undefined
  readonly #env: Record<string, string | undefined>
  #shownTitle: string | undefined
  #shownProgress: TerminalProgress = "none"
  #titleRestore: TerminalMode | undefined
  #progressRestore: TerminalMode | undefined
  readonly #opts: TerminalStatusOptions

  constructor(
    private terminal: Terminal,
    opts: TerminalStatusOptions = {},
    env: Record<string, string | undefined> = process.env,
  ) {
    this.#env = env
    this.#opts = {
      notify: opts.notify ?? DEFAULT_TUI_NOTIFY,
      title: opts.title ?? DEFAULT_TUI_TITLE,
      progress: (opts.progress ?? DEFAULT_TUI_PROGRESS) && progressSupported(env),
      bell: opts.bell ?? DEFAULT_TUI_BELL,
    }
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.terminal.enableMode(focusReporting)
  }

  setTitle(title: string): void {
    if (!this.#started || !this.#opts.title) return
    // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize terminal title input
    this.#title = truncateToWidth(displayTitle(title.replace(/[\x00-\x1f\x7f-\x9f]/g, "")), 128, "…")
    this.#schedule()
  }

  setProgress(state: TerminalProgress): void {
    if (!this.#started || !this.#opts.progress) return
    this.#progress = state === "paused" || state === "indeterminate" ? state : "none"
    this.#schedule()
  }

  /** App lifecycle supplies focus and wait context; the extension still requests the alert. */
  setRunning(running: boolean, aborted = false): void {
    if (running !== this.#running) this.#titleAt = -Infinity
    this.#running = running
    this.#completed = !running && !aborted && this.#focused === false
    if (running && !this.#dialogWaiting) this.#alerted = this.#acknowledged = false
    this.#schedule()
  }

  setWaiting(pending: number, attention: boolean): void {
    const waiting = pending > 0
    if (waiting !== this.#dialogWaiting) {
      this.#titleAt = -Infinity
      this.#alerted = this.#acknowledged = false
      this.#completed = false
      this.#ringPending = false
    }
    this.#dialogWaiting = waiting
    this.#attention = attention
    this.#schedule()
  }

  setFocused(focused: boolean): void {
    this.#focused = focused
    this.#acknowledged = focused
    if (focused) {
      this.#completed = false
      this.#ringPending = false
    }
    this.#schedule()
  }

  bell(): void {
    if (!this.#started) return
    this.#ringPending = true
    this.#schedule()
  }

  #schedule(): void {
    if (this.#pending) return
    this.#pending = true
    queueMicrotask(() => {
      this.#pending = false
      if (!this.#started) return
      this.#flush()
    })
  }

  #flush(): void {
    let out = ""
    const waiting = this.#dialogWaiting || this.#completed
    const title =
      waiting && this.#title !== undefined
        ? truncateToWidth(`? ${this.#title.replace(/^● /, "")}`, 128, "…")
        : this.#title
    clearTimeout(this.#titleTimer)
    this.#titleTimer = undefined
    if (title !== undefined && title !== this.#shownTitle) {
      const delay = this.#running ? 1000 - (Date.now() - this.#titleAt) : 0
      if (delay > 0) this.#titleTimer = setTimeout(() => this.#schedule(), delay)
      else {
        if (!this.#titleRestore) {
          this.#titleRestore = { on: osc.pushTitle, off: osc.title("") + osc.popTitle }
          this.terminal.enableMode(this.#titleRestore)
        }
        this.#shownTitle = title
        this.#titleAt = Date.now()
        out += osc.title(title)
      }
    }
    if (this.#progress !== undefined) {
      if (!this.#progressRestore) {
        this.#progressRestore = { on: "", off: osc.progress("none") }
        this.terminal.enableMode(this.#progressRestore)
      }
      if (this.#progress !== this.#shownProgress) {
        this.#shownProgress = this.#progress
        out += osc.progress(this.#progress, this.#progress === "paused" ? 100 : 0)
      }
    }
    // Decide after app/extension events have coalesced, using the latest focus and wait state.
    if (this.#ringPending) {
      const waiting = this.#dialogWaiting || this.#completed
      const eligible =
        !waiting ||
        (!this.#alerted &&
          !this.#acknowledged &&
          (this.#focused === false || (this.#focused === undefined && this.#attention)))
      if (eligible) {
        if (this.#opts.bell) out += osc.bell
        if (waiting) {
          this.#alerted = true
          if (this.#opts.notify === "auto")
            out += notification(
              this.#env,
              this.#dialogWaiting ? "Amira is waiting for your answer" : "Amira finished the turn",
            )
        }
      }
    }
    this.#ringPending = false
    if (out) this.terminal.write(out)
  }

  /** Drop queued effects, clear status and disable focus before the terminal is restored. */
  stop(): void {
    if (!this.#started) return
    this.#started = false
    clearTimeout(this.#titleTimer)
    this.#titleTimer = undefined
    this.#titleAt = -Infinity
    this.#ringPending = false
    this.#running = this.#dialogWaiting = this.#completed = this.#alerted = this.#acknowledged = false
    this.#focused = undefined
    if (this.#progressRestore) this.terminal.disableMode(this.#progressRestore)
    if (this.#titleRestore) this.terminal.disableMode(this.#titleRestore)
    this.terminal.disableMode(focusReporting)
    this.#progressRestore = undefined
    this.#titleRestore = undefined
    this.#title = this.#shownTitle = undefined
    this.#progress = undefined
    this.#shownProgress = "none"
  }
}
