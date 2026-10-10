// Owns turn activity, retry labels and the activity line's clocks and rendering.
import type { RenderContext, Spinner } from "@amira/tui-kit"
import { glyphs } from "../glyphs.ts"
import { activityRow } from "./activity-row.ts"

/** A model request waiting to be sent again: model.retry, and when the wait ends. */
export interface RetryState {
  attempt: number
  maxRetries: number
  status?: number
  kind: string
  at: number
}

/** "retrying in 6s (2/3) · 429": the wait for a failed model request to be sent again. */
export function retryLabel(r: RetryState, now = Date.now()): string {
  const secs = Math.max(0, Math.ceil((r.at - now) / 1000))
  const why = r.status !== undefined ? String(r.status) : r.kind
  return `retrying in ${secs}s (${r.attempt}/${r.maxRetries}) ${glyphs.separator} ${why}`
}

/**
 * What the turn is doing now, as the activity line names it: the most specific activity first.
 * Running tools are counted, not named: their rows under the reply name them (D10).
 */
export function activityLabel(s: {
  compacting: boolean
  /** The compaction runs on the provider's server (compact.start `native`). */
  onServer?: boolean
  running: readonly string[]
  preparing: string | undefined
  thinking: boolean
  responding?: boolean
  /** A failed model request waiting to be sent again (model.retry), and when it goes out. */
  retry?: RetryState | undefined
  /** A dialog waits for the user's answer. */
  waiting?: boolean
  /** The retry status.changed names ("retrying (2/3)"), when no model.retry says more. */
  retrying?: string | undefined
}): string {
  // Once the wait is over the request is on its way again: the other activities apply.
  if (s.retry && s.retry.at > Date.now()) return retryLabel(s.retry)
  if (s.compacting) return s.onServer ? "compacting on the server" : "compacting the conversation"
  if (s.waiting) return "waiting for you"
  // model.retry says when the wait is over; the status's own retry words only stand in for it.
  if (s.retrying && !s.retry) return s.retrying
  if (s.running.length) return `${s.running.length} ${s.running.length === 1 ? "tool" : "tools"} running`
  if (s.preparing) return `preparing ${s.preparing}`
  return s.thinking ? "thinking" : s.responding ? "responding" : "working"
}

/**
 * The retry the model request is in, as status.changed tells it: "retrying in 6s (2/3) · 429"
 * when the event says when and why, else its reason as given ("retrying (2/3)"). Undefined when
 * the status is not about a retry.
 */
export function statusRetryLabel(data: {
  reason?: string
  retry?: { attempt?: number; maxRetries?: number; delayMs?: number; status?: number; code?: string }
}): string | undefined {
  const r = data.retry
  if (r && (r.attempt !== undefined || r.delayMs !== undefined)) {
    const when = r.delayMs !== undefined ? ` in ${Math.max(1, Math.ceil(r.delayMs / 1000))}s` : ""
    const count = r.attempt !== undefined ? ` (${r.attempt}${r.maxRetries ? `/${r.maxRetries}` : ""})` : ""
    const why = r.status ?? r.code
    return `retrying${when}${count}${why !== undefined ? ` ${glyphs.separator} ${why}` : ""}`
  }
  return data.reason?.startsWith("retrying") ? data.reason : undefined
}

/** The last line of the reasoning streamed so far, for the activity line; "" before any. */
export function lastReasoningLine(text: string): string {
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.replace(/\s+/g, " ").trim()
    if (line) return line
  }
  return ""
}

/** Output tokens a streamed text is worth, until the reply's usage says. */
const estimateTokens = (chars: number) => Math.ceil(chars / 4)

export interface ActivityClock {
  turnStartedAt: number
  turnTokens: number
}

export interface TurnActivityRenderOptions {
  running: readonly string[]
  waiting: boolean
  spinner: Spinner
  stop?: string
}

export interface TurnActivity {
  readonly working: boolean
  readonly compacting: boolean
  beginSend(): ActivityClock
  sendFailed(clock: ActivityClock, busy: boolean): void
  turnStarted(beforeClock: () => void): void
  setRetry(retry: RetryState | undefined): void
  messageStarted(): void
  textDelta(text: string, render: () => void): void
  thinkingDelta(text: string, render: () => void): void
  serverToolDelta(render: () => void): void
  toolCallDelta(argsLength: number, name: string | undefined): void
  messageEnded(outputTokens: number | undefined): void
  toolStarted(): void
  turnEnded(): void
  setRetrying(retrying: string | undefined): void
  startCompaction(onServer: boolean): void
  endCompaction(): void
  render(width: number, ctx: RenderContext, options: TurnActivityRenderOptions): string[]
}

export function createTurnActivity(): TurnActivity {
  let working = false
  let thinking = false
  /** The end of the reasoning streamed in the current reply, whose last line the activity line shows. */
  let reasoning = ""
  /** The model request is being tried again, as the activity line says (status.changed). */
  let retrying: string | undefined
  let compacting = false
  let compactingOnServer = false
  /** A failed model request waiting to be sent again (model.retry), until the next reply starts. */
  let retry: RetryState | undefined
  /** Tool the model is currently writing a call for, before it runs. */
  let preparing: string | undefined
  /** When the running turn started, and the output tokens its finished replies used. */
  let turnStartedAt = 0
  let turnTokens = 0
  /**
   * send() started the clock for the turn it asked for: the prompt may wait for a compaction
   * before turn.start comes, and the activity line must not show the last turn's numbers then.
   */
  let clockFromSend = false
  /** When a compaction outside a turn (/compact) started. */
  let compactStartedAt = 0
  /** Characters of the reply streaming now: its tokens until its usage arrives. */
  let streamedChars = 0
  let responding = false
  let stepStartedAt = 0
  let stepKind = ""
  let lastRate = 0
  let messageStartedAt = 0
  let animationGlyph = ""
  let animationMs = 0

  /** The activity line counts the turn's time and tokens from here. */
  const startClock = () => {
    turnStartedAt = Date.now()
    turnTokens = 0
    stepStartedAt = turnStartedAt
    stepKind = ""
    lastRate = 0
    responding = false
    animationGlyph = ""
  }

  return {
    get working() {
      return working
    },
    get compacting() {
      return compacting
    },
    beginSend() {
      const clock = { turnStartedAt, turnTokens }
      working = true
      startClock()
      clockFromSend = true
      return clock
    },
    sendFailed(clock, busy) {
      clockFromSend = false
      if (busy) {
        // A turn we did not know about is running; send this one after it, and keep its clock.
        turnStartedAt = clock.turnStartedAt
        turnTokens = clock.turnTokens
      } else working = false
    },
    turnStarted(beforeClock) {
      working = true
      thinking = false
      beforeClock()
      if (!clockFromSend) startClock()
      clockFromSend = false
      streamedChars = 0
    },
    setRetry(next) {
      if (next) {
        stepStartedAt = Date.now()
        stepKind = ""
      }
      retry = next
    },
    messageStarted() {
      retry = undefined
      thinking = false
      reasoning = ""
      preparing = undefined
      streamedChars = 0
      responding = false
      stepStartedAt = Date.now()
      messageStartedAt = stepStartedAt
    },
    textDelta(text, render) {
      retry = undefined
      thinking = false
      responding = true
      render()
      streamedChars += text.length
    },
    thinkingDelta(text, render) {
      retry = undefined
      thinking = true
      responding = false
      render()
      // Only the end is shown; keep enough of it to hold a whole line.
      reasoning = (reasoning + text).slice(-2000)
      streamedChars += text.length
    },
    serverToolDelta(render) {
      retry = undefined
      thinking = false
      render()
    },
    toolCallDelta(argsLength, name) {
      retry = undefined
      streamedChars += argsLength
      if (name) {
        thinking = false
        preparing = name
      }
    },
    messageEnded(outputTokens) {
      const tokens = outputTokens ?? estimateTokens(streamedChars)
      lastRate = tokens / Math.max(0.001, (Date.now() - messageStartedAt) / 1000)
      turnTokens += tokens
      streamedChars = 0
      responding = false
    },
    toolStarted() {
      preparing = undefined
    },
    turnEnded() {
      working = false
      preparing = undefined
      retrying = undefined
      reasoning = ""
    },
    setRetrying(next) {
      retrying = next
    },
    startCompaction(onServer) {
      compacting = true
      compactingOnServer = onServer
      compactStartedAt = Date.now()
      stepStartedAt = compactStartedAt
      stepKind = ""
      animationGlyph = ""
    },
    endCompaction() {
      compacting = false
    },
    render(width, ctx, options) {
      if (!working && !compacting) return []
      const label = activityLabel({
        compacting,
        onServer: compactingOnServer,
        running: options.running,
        preparing,
        thinking,
        responding,
        waiting: options.waiting,
        retry,
        retrying,
      })
      const now = Date.now()
      // Countdown text/counts changing do not restart the step's clock.
      const kind = label.replace(/\d+/g, "#")
      if (kind !== stepKind) {
        stepKind = kind
        stepStartedAt = now
      }
      const turnMs = now - (working ? turnStartedAt : compactStartedAt)
      // Stream/input redraws can be faster than the spinner: only its ticks move the highlight.
      if (animationGlyph !== options.spinner.glyph) {
        animationGlyph = options.spinner.glyph
        animationMs = turnMs
      }
      const stepMs = now - stepStartedAt
      const tokens = turnTokens + estimateTokens(streamedChars)
      const rate = streamedChars
        ? estimateTokens(streamedChars) / Math.max(0.001, (now - messageStartedAt) / 1000)
        : lastRate
      return [
        activityRow(
          {
            label,
            spinner: options.spinner.glyph,
            stepMs,
            turnMs,
            tokens,
            rate,
            stop: options.stop ?? "esc stop",
            animationMs,
          },
          width,
          ctx,
        ),
      ]
    },
  }
}
