import type { TerminalApi, TerminalProgress } from "@amira/api"
import { DEFAULT_TUI_BELL, DEFAULT_TUI_PROGRESS, DEFAULT_TUI_TITLE } from "@amira/api"
import {
  focusReporting,
  osc,
  progressSupported,
  type Terminal,
  type TerminalMode,
  truncateToWidth,
} from "@amira/tui-kit"

export interface TerminalStatusOptions {
  title?: boolean
  progress?: boolean
  bell?: boolean
}

/** Coalesces structured effects at a microtask boundary, outside synchronous frame writes. */
export class TerminalStatus implements TerminalApi {
  #started = false
  #pending = false
  #title: string | undefined
  #progress: TerminalProgress | undefined
  #ringPending = false
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
    this.#opts = {
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
    this.#title = truncateToWidth(title.replace(/[\x00-\x1f\x7f-\x9f]/g, ""), 128, "…")
    this.#schedule()
  }

  setProgress(state: TerminalProgress): void {
    if (!this.#started || !this.#opts.progress) return
    this.#progress = state === "paused" || state === "indeterminate" ? state : "none"
    this.#schedule()
  }

  bell(): void {
    if (!this.#started || !this.#opts.bell) return
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
    if (this.#title !== undefined && this.#title !== this.#shownTitle) {
      if (!this.#titleRestore) {
        this.#titleRestore = { on: osc.pushTitle, off: osc.title("") + osc.popTitle }
        this.terminal.enableMode(this.#titleRestore)
      }
      this.#shownTitle = this.#title
      out += osc.title(this.#title)
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
    // Several bells in one tick ring once: an extension cannot flood the terminal with them.
    if (this.#ringPending) out += osc.bell
    this.#ringPending = false
    if (out) this.terminal.write(out)
  }

  /** Drop queued effects, clear status and disable focus before the terminal is restored. */
  stop(): void {
    if (!this.#started) return
    this.#started = false
    this.#ringPending = false
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
