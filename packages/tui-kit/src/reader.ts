import { InputParser } from "./input.ts"
import {
  discardParserPaste,
  hasPasteOrigin,
  parserPasteState,
  registerReaderPasteControl,
} from "./input-paste-control.ts"
import type { InputEvent } from "./keys.ts"
import type { Terminal } from "./terminal.ts"

export interface InputReaderOptions {
  /** How long a lone ESC waits for the rest of a sequence before it counts as the Esc key. */
  escapeTimeoutMs?: number
  /** How long a sequence cut short (ESC [ with parameters) may wait for its end before it is dropped. */
  sequenceTimeoutMs?: number
  /** A paste whose end marker never comes ends after this long without input. */
  pasteTimeoutMs?: number
  /** Content-free framing state; starts before dispatch, ends on completion, timeout, discard or stop. */
  onPasteState?: (pending: boolean) => void
}

const attached = new WeakSet<Terminal>()

/** True while an `InputReader` is reading from `term`. */
export function hasInputReader(term: Terminal): boolean {
  return attached.has(term)
}

/**
 * Feeds terminal input through an `InputParser`. Resolves a lone ESC after a short timeout, drops
 * a sequence that was cut short, and ends a paste whose end marker never comes.
 */
export class InputReader {
  private parser = new InputParser()
  private timer: ReturnType<typeof setTimeout> | undefined
  private off: (() => void) | undefined
  private stopped = false
  private readonly escapeTimeoutMs: number
  private readonly sequenceTimeoutMs: number
  private readonly pasteTimeoutMs: number
  private dispatching = new Set<InputEvent[]>()
  private pasteFrames = new Set<InputEvent[]>()
  private pastePending = false
  private readonly onPasteState: InputReaderOptions["onPasteState"]
  private discarded = new WeakSet<InputEvent>()
  private readonly discardPendingPaste = () => {
    discardParserPaste(this.parser)
    this.pasteFrames.clear()
    // feed() parses a whole chunk before dispatch. A callback can change owners (and even
    // reenter feed) while paste events from that old chunk are still waiting in any frame.
    for (const events of this.dispatching) {
      for (const event of events) {
        if (event.type === "paste" || hasPasteOrigin(event)) this.discarded.add(event)
      }
    }
    this.notifyPasteState()
  }

  constructor(
    private terminal: Terminal,
    private onEvent: (e: InputEvent) => void,
    opts: InputReaderOptions = {},
  ) {
    this.escapeTimeoutMs = opts.escapeTimeoutMs ?? 40
    this.sequenceTimeoutMs = Math.max(this.escapeTimeoutMs, opts.sequenceTimeoutMs ?? 500)
    this.pasteTimeoutMs = opts.pasteTimeoutMs ?? 1500
    this.onPasteState = opts.onPasteState
    registerReaderPasteControl(this.terminal, this.discardPendingPaste)
  }

  start(): void {
    this.stopped = false
    registerReaderPasteControl(this.terminal, this.discardPendingPaste)
    if (this.off) return
    attached.add(this.terminal)
    this.off = this.terminal.onInput((data) => this.feed(data))
    this.notifyPasteState()
  }

  stop(): void {
    this.stopped = true
    if (this.off) attached.delete(this.terminal)
    this.off?.()
    this.off = undefined
    clearTimeout(this.timer)
    this.notifyPasteState()
  }

  /** Feeds data directly, e.g. input that arrived while capabilities were being probed. */
  feed(data: string): void {
    clearTimeout(this.timer)
    this.parse(() => this.parser.feed(data))
    this.schedule()
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.parser.pasting) {
      this.timer = setTimeout(() => this.parse(() => this.parser.endPaste()), this.pasteTimeoutMs)
      return
    }
    if (!this.parser.pending) return
    this.timer = setTimeout(() => {
      this.parse(() => this.parser.flush())
      if (this.stopped || !this.parser.pending) return
      this.timer = setTimeout(
        () => this.parse(() => this.parser.flush(true)),
        this.sequenceTimeoutMs - this.escapeTimeoutMs,
      )
    }, this.escapeTimeoutMs)
  }

  private parse(read: () => InputEvent[]): void {
    const before = parserPasteState(this.parser)
    const events = read()
    const after = parserPasteState(this.parser)
    this.dispatch(events, before.pending || after.pending || before.revision !== after.revision)
  }

  private notifyPasteState(): void {
    const pending = !this.stopped && (parserPasteState(this.parser).pending || this.pasteFrames.size > 0)
    if (pending === this.pastePending) return
    this.pastePending = pending
    this.onPasteState?.(pending)
  }

  private dispatch(events: InputEvent[], pasteFrame: boolean): void {
    this.dispatching.add(events)
    if (pasteFrame) this.pasteFrames.add(events)
    try {
      // Register the whole frame first: abort listeners may discard it or reenter input.
      this.notifyPasteState()
      for (const e of events) {
        if (!this.discarded.has(e)) this.onEvent(e)
      }
    } finally {
      this.dispatching.delete(events)
      this.pasteFrames.delete(events)
      this.notifyPasteState()
    }
  }
}
