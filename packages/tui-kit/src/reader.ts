import { InputParser } from "./input.ts"
import type { InputEvent } from "./keys.ts"
import type { Terminal } from "./terminal.ts"

export interface InputReaderOptions {
  /** How long a lone ESC waits for the rest of a sequence before it counts as the Esc key. */
  escapeTimeoutMs?: number
  /** How long a sequence cut short (ESC [ with parameters) may wait for its end before it is dropped. */
  sequenceTimeoutMs?: number
}

/** Feeds terminal input through an `InputParser` and resolves a lone ESC after a timeout. */
export class InputReader {
  private parser = new InputParser()
  private timer: ReturnType<typeof setTimeout> | undefined
  private off: (() => void) | undefined
  private stopped = false
  private readonly escapeTimeoutMs: number
  private readonly sequenceTimeoutMs: number

  constructor(
    private terminal: Terminal,
    private onEvent: (e: InputEvent) => void,
    opts: InputReaderOptions = {},
  ) {
    this.escapeTimeoutMs = opts.escapeTimeoutMs ?? 40
    this.sequenceTimeoutMs = Math.max(this.escapeTimeoutMs, opts.sequenceTimeoutMs ?? 500)
  }

  start(): void {
    this.stopped = false
    this.off ??= this.terminal.onInput((data) => this.feed(data))
  }

  stop(): void {
    this.stopped = true
    this.off?.()
    this.off = undefined
    clearTimeout(this.timer)
  }

  /** Feeds data directly, e.g. input that arrived while capabilities were being probed. */
  feed(data: string): void {
    clearTimeout(this.timer)
    this.dispatch(this.parser.feed(data))
    this.schedule()
  }

  private schedule(): void {
    if (this.stopped || !this.parser.pending) return
    this.timer = setTimeout(() => {
      this.dispatch(this.parser.flush())
      if (this.stopped || !this.parser.pending) return
      this.timer = setTimeout(
        () => this.dispatch(this.parser.flush(true)),
        this.sequenceTimeoutMs - this.escapeTimeoutMs,
      )
    }, this.escapeTimeoutMs)
  }

  private dispatch(events: InputEvent[]): void {
    for (const e of events) this.onEvent(e)
  }
}
