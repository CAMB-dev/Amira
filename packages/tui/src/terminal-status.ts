import path from "node:path"
import { focusReporting, osc, type ProgressState, type Terminal } from "@amira/tui-kit"
import { Glyphs } from "./glyphs.ts"

export interface TerminalStatusOptions {
  /** Set the window title (default true). */
  title?: boolean
  /** Drive the progress indicator (default true); pass false where OSC 9;4 means something else. */
  progress?: boolean
  /** Ring the bell for a finished turn or a question while the user is away (default true). */
  bell?: boolean
  /**
   * Where the terminal does not report focus: a turn at least this long rings the bell when it
   * ends, and a dialog opening that far into a turn. Default 15 s.
   */
  longTurnMs?: number
  now?: () => number
}

/**
 * What Amira tells the terminal around the drawing: a title naming the folder and branch,
 * marked while a turn runs; the progress indicator (busy while working, paused while a dialog
 * waits for an answer); and the bell when a turn ends or a dialog opens while the user looks
 * elsewhere. Writes only on change, and `stop()` hands the title and indicator back.
 */
export class TerminalStatus {
  #folder: string
  #branch: string | undefined
  #working = false
  #waiting = false
  /** Undefined until the terminal reports focus at least once. */
  #focused: boolean | undefined
  #turnStartedAt: number | undefined
  #shownTitle: string | undefined
  #shownProgress: ProgressState = "none"
  #started = false
  readonly #title: boolean
  readonly #progress: boolean
  readonly #bell: boolean
  readonly #longTurnMs: number
  readonly #now: () => number

  constructor(
    private terminal: Terminal,
    cwd: string,
    opts: TerminalStatusOptions = {},
  ) {
    this.#folder = path.basename(cwd) || cwd
    this.#title = opts.title ?? true
    this.#progress = opts.progress ?? true
    this.#bell = opts.bell ?? true
    this.#longTurnMs = opts.longTurnMs ?? 15_000
    this.#now = opts.now ?? Date.now
  }

  /** The title as it reads now: "Amira · proj ⎇ main", with a marker in front while working. */
  get title(): string {
    const branch = this.#branch ? ` ${Glyphs.branch} ${this.#branch}` : ""
    const base = `Amira ${Glyphs.separator} ${this.#folder}${branch}`
    return this.#working ? `${Glyphs.working} ${base}` : base
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    if (this.#title) this.terminal.write(osc.pushTitle)
    // Focus reports only serve the bell.
    if (this.#bell) this.terminal.enableMode(focusReporting)
    this.#sync()
  }

  /** Hands back the title (the saved one, or the terminal's own) and clears the indicator. */
  stop(): void {
    if (!this.#started) return
    this.#started = false
    let out = ""
    if (this.#progress && this.#shownProgress !== "none") out += osc.progress("none")
    if (this.#title) out += osc.title("") + osc.popTitle
    if (out) this.terminal.write(out)
    if (this.#bell) this.terminal.disableMode(focusReporting)
    this.#shownProgress = "none"
    this.#shownTitle = undefined
  }

  setBranch(branch: string | undefined): void {
    this.#branch = branch
    this.#sync()
  }

  setFolder(cwd: string): void {
    this.#folder = path.basename(cwd) || cwd
    this.#sync()
  }

  turnStarted(): void {
    this.#working = true
    this.#turnStartedAt = this.#now()
    this.#sync()
  }

  /** An interrupted turn does not ring: the user just pressed the key. */
  turnEnded(reason: "completed" | "aborted" | "error" | string): void {
    const long = this.#turnStartedAt !== undefined && this.#now() - this.#turnStartedAt >= this.#longTurnMs
    this.#working = false
    this.#turnStartedAt = undefined
    this.#sync()
    if (reason !== "aborted") this.#ring(long)
  }

  /** Whether a dialog waits for an answer. Opening one may ring. */
  setWaiting(waiting: boolean): void {
    if (waiting === this.#waiting) return
    this.#waiting = waiting
    this.#sync()
    if (waiting) {
      const long = this.#turnStartedAt !== undefined && this.#now() - this.#turnStartedAt >= this.#longTurnMs
      this.#ring(long)
    }
  }

  focus(focused: boolean): void {
    this.#focused = focused
  }

  /** Rings when the terminal is known to be in the background, else only after a long wait. */
  #ring(long: boolean): void {
    if (!this.#bell || !this.#started) return
    if (this.#focused === undefined ? long : !this.#focused) this.terminal.write(osc.bell)
  }

  #sync(): void {
    if (!this.#started) return
    let out = ""
    if (this.#title && this.title !== this.#shownTitle) {
      this.#shownTitle = this.title
      out += osc.title(this.title)
    }
    const progress: ProgressState = this.#waiting ? "paused" : this.#working ? "indeterminate" : "none"
    if (this.#progress && progress !== this.#shownProgress) {
      this.#shownProgress = progress
      // Paused shows as a full yellow ring; at 0 it would not show at all.
      out += osc.progress(progress, progress === "paused" ? 100 : 0)
    }
    if (out) this.terminal.write(out)
  }
}
