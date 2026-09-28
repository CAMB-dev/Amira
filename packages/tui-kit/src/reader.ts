import { InputParser } from "./input.ts"
import type { InputEvent } from "./keys.ts"
import type { Terminal } from "./terminal.ts"

export interface InputReaderOptions {
  /** How long a lone ESC waits for the rest of a sequence before it counts as the Esc key. */
  escapeTimeoutMs?: number
}

/** Feeds terminal input through an `InputParser` and resolves a lone ESC after a timeout. */
export class InputReader {
  private parser = new InputParser()
  private timer: ReturnType<typeof setTimeout> | undefined
  private off: (() => void) | undefined
  private readonly escapeTimeoutMs: number

  constructor(
    private terminal: Terminal,
    private onEvent: (e: InputEvent) => void,
    opts: InputReaderOptions = {},
  ) {
    this.escapeTimeoutMs = opts.escapeTimeoutMs ?? 40
  }

  start(): void {
    this.off ??= this.terminal.onInput((data) => this.feed(data))
  }

  stop(): void {
    this.off?.()
    this.off = undefined
    clearTimeout(this.timer)
  }

  /** Feeds data directly, e.g. input that arrived while capabilities were being probed. */
  feed(data: string): void {
    clearTimeout(this.timer)
    this.dispatch(this.parser.feed(data))
    if (this.parser.pending) {
      this.timer = setTimeout(() => this.dispatch(this.parser.flush()), this.escapeTimeoutMs)
    }
  }

  private dispatch(events: InputEvent[]): void {
    for (const e of events) this.onEvent(e)
  }
}
