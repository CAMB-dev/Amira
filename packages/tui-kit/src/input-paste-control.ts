import type { InputParser } from "./input.ts"
import type { InputEvent } from "./keys.ts"
import type { Terminal } from "./terminal.ts"

type PasteState = { revision: number; pending: boolean }
const parsers = new WeakMap<InputParser, { discard: () => void; state: () => PasteState }>()
const readers = new WeakMap<Terminal, () => void>()

/** Internal controls, deliberately absent from the kit's public entry point. */
export function registerParserPasteControl(
  parser: InputParser,
  discard: () => void,
  state: () => PasteState,
): void {
  parsers.set(parser, { discard, state })
}

/** Framing only: even an empty paste advances the revision, without returning any content. */
export function parserPasteState(parser: InputParser): PasteState {
  return parsers.get(parser)?.state() ?? { revision: 0, pending: false }
}

export function discardParserPaste(parser: InputParser): void {
  parsers.get(parser)?.discard()
}

export function registerReaderPasteControl(terminal: Terminal, discard: () => void): void {
  readers.set(terminal, discard)
}

/** Called at a terminal's input-ownership boundary before the new owner can receive input. */
export function discardPendingPaste(terminal: Terminal): void {
  readers.get(terminal)?.()
}

// A timed-out paste can be decoded as keys. Keep origin provenance after parser lookahead
// sees its ending, so a boundary during dispatch can still discard only that old tail.
const originEvents = new WeakSet<InputEvent>()
export function markPasteOrigin(event: InputEvent): void {
  originEvents.add(event)
}
export function hasPasteOrigin(event: InputEvent): boolean {
  return originEvents.has(event)
}
