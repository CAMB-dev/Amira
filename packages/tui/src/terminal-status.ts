import path from "node:path"
import { focusReporting, osc, type ProgressState, type Terminal, type TerminalMode } from "@amira/tui-kit"
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
  /** Pushes the title on start, and hands it and the indicator back when left. */
  #restore: TerminalMode | undefined
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
    // Kept as a terminal mode, so the terminal's own restore on a crash or a signal hands the
    // title and the indicator back too, not only `stop()`. An empty title makes the terminal
    // show its own (Windows Terminal: the tab's starting title); the pop restores a saved one.
    const off =
      (this.#progress ? osc.progress("none") : "") + (this.#title ? osc.title("") + osc.popTitle : "")
    this.#restore = off ? { on: this.#title ? osc.pushTitle : "", off } : undefined
    if (this.#restore) this.terminal.enableMode(this.#restore)
    // Focus reports only serve the bell.
    if (this.#bell) this.terminal.enableMode(focusReporting)
    this.#sync()
  }

  /** Hands back the title (the saved one, or the terminal's own) and clears the indicator. */
  stop(): void {
    if (!this.#started) return
    this.#started = false
    if (this.#restore) this.terminal.disableMode(this.#restore)
    this.#restore = undefined
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

  /**
   * Whether a dialog waits for an answer. Opening one may ring; `hidden` rings in any case,
   * for a dialog the user cannot see (a full-screen view covers it).
   */
  setWaiting(waiting: boolean, hidden = false): void {
    if (waiting === this.#waiting) {
      if (waiting && hidden) this.#ring(true, true)
      return
    }
    this.#waiting = waiting
    this.#sync()
    if (waiting) {
      const long = this.#turnStartedAt !== undefined && this.#now() - this.#turnStartedAt >= this.#longTurnMs
      this.#ring(long, hidden)
    }
  }

  focus(focused: boolean): void {
    this.#focused = focused
  }

  /** Rings when the terminal is known to be in the background, else only after a long wait. */
  #ring(long: boolean, always = false): void {
    if (!this.#bell || !this.#started) return
    if (always || (this.#focused === undefined ? long : !this.#focused)) this.terminal.write(osc.bell)
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
