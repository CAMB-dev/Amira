import type { AssistantMessage, EventMap } from "@amira/api"

/** Provider-stream times in milliseconds, measured from our event envelopes. */
export interface ReplyTiming {
  start: number
  first?: number
  last?: number
  /** First readable thinking and answer deltas, used only by the fallback path. */
  thinking?: number
  reply?: number
  thinkingDisplay?: "summarized" | "omitted" | "raw"
  thinkingBlocks?: { index?: number; start: number; end?: number }[]
  splitIncomplete?: boolean
}

/** A streamed piece is too short to estimate meaningfully below 200 ms. */
export function tokensPerSecond(tokens: number, first: number, end: number): number | undefined {
  const seconds = (end - first) / 1000
  return tokens > 0 && seconds >= 0.2 ? tokens / seconds : undefined
}

export const estimateChars = (chars: number) => Math.ceil(chars / 4)
const estimate = (text: string) => estimateChars(text.length)
const estimateReply = (message: AssistantMessage) =>
  message.content.reduce(
    (n, b) =>
      n +
      (b.type === "text"
        ? estimate(b.text)
        : b.type === "toolCall"
          ? estimate(b.name + JSON.stringify(b.args))
          : 0),
    0,
  )
export const rate = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.round(n)))
const measuredRate = (tokens: number, ms: number) =>
  tokens >= 0 && ms > 0 ? (tokens * 1000) / ms : undefined

/** An output estimate is needed only when no provider output count was reported. */
export function outputTokens(message: AssistantMessage): { tokens: number; estimated: boolean } {
  if (message.usage !== undefined && message.usage.outputReported !== false)
    return { tokens: message.usage.output, estimated: false }
  return {
    tokens: message.content.reduce(
      (n, b) =>
        n +
        (b.type === "text" || b.type === "thinking"
          ? estimate(b.text)
          : b.type === "toolCall"
            ? estimate(b.name + JSON.stringify(b.args))
            : 0),
      0,
    ),
    estimated: true,
  }
}

export interface RequestSpeed {
  output?: string
  ttft?: string
  split?: string
  note?: string
}

/** Total output is always primary. A requested summary makes phase speeds meaningless. */
export function requestSpeed(
  message: AssistantMessage,
  t: ReplyTiming,
  end: number,
  silentGap?: number,
): RequestSpeed {
  const first = t.first ?? t.thinking ?? t.reply
  const last = t.last ?? end
  const total = outputTokens(message)
  const output = first === undefined ? undefined : measuredRate(total.tokens, last - first)
  const result: RequestSpeed = {
    ...(output !== undefined ? { output: `output ${total.estimated ? "~" : ""}${rate(output)} tok/s` } : {}),
    ...(first !== undefined && first >= t.start ? { ttft: `${((first - t.start) / 1000).toFixed(2)}s` } : {}),
  }
  if (t.thinkingDisplay === "summarized") {
    result.note = "summarized thinking; no split"
    return result
  }
  const reasoning = message.usage?.reasoning
  if (reasoning !== undefined) {
    const blocks = t.thinkingBlocks ?? []
    const complete =
      !t.splitIncomplete &&
      blocks.every(
        (b) =>
          b.end !== undefined && b.end >= b.start && first !== undefined && b.start >= first && b.end <= last,
      )
    const thinkingMs = blocks.reduce((ms, b) => ms + ((b.end ?? b.start) - b.start), 0)
    if (
      first !== undefined &&
      !total.estimated &&
      complete &&
      thinkingMs <= last - first &&
      reasoning >= 0 &&
      reasoning <= total.tokens &&
      (reasoning === 0 || blocks.length > 0) &&
      (t.thinkingDisplay === "raw" || t.thinkingDisplay === "omitted")
    ) {
      const reply = measuredRate(Math.max(0, total.tokens - reasoning), last - first - thinkingMs)
      const thinking = measuredRate(reasoning, thinkingMs)
      const parts = [
        ...(reply !== undefined ? [`reply ${rate(reply)} tok/s`] : []),
        ...(thinking !== undefined ? [`thinking ${rate(thinking)} tok/s`] : []),
      ]
      if (parts.length) result.split = parts.join(" · ")
    } else if (t.thinkingDisplay === undefined && reasoning > 0 && t.reply !== undefined) {
      // Counts are real, but an unknown display cannot give an exact phase duration.
      const tokens = total.estimated ? estimateReply(message) : Math.max(0, total.tokens - reasoning)
      const reply = tokensPerSecond(tokens, t.reply, last)
      if (reply !== undefined)
        result.split = `reply ~${rate(reply)} tok/s${t.thinking === undefined ? " (hidden reasoning)" : ""}`
    }
    return result
  }
  // Providers without reasoning counts retain marked estimates, also for unknown display.
  const hidden =
    t.thinking === undefined &&
    (message.content.some((b) => b.type === "thinking") ||
      (silentGap !== undefined && t.reply !== undefined && t.reply - t.start >= silentGap))
  const thoughtTokens = message.content.reduce(
    (n, b) => n + (b.type === "thinking" ? estimate(b.text) : 0),
    0,
  )
  const replyTokens = estimateReply(message)
  const reasoned = hidden || t.thinking !== undefined
  const reply =
    t.reply === undefined
      ? undefined
      : tokensPerSecond(reasoned || total.estimated ? replyTokens : total.tokens, t.reply, last)
  const thinking =
    t.thinking === undefined ? undefined : tokensPerSecond(thoughtTokens, t.thinking, t.reply ?? last)
  const parts = [
    ...(reply !== undefined && (reasoned || total.estimated)
      ? [`reply ~${rate(reply)} tok/s${hidden ? " (hidden reasoning)" : ""}`]
      : []),
    ...(thinking !== undefined ? [`thinking ~${rate(thinking)} tok/s`] : []),
  ]
  if (parts.length) result.split = parts.join(" · ")
  return result
}

/** Compact representation, also used by formatter regression tests. */
export function replySpeed(
  message: AssistantMessage,
  timing: ReplyTiming,
  end: number,
  silentGap?: number,
): string | undefined {
  const speed = requestSpeed(message, timing, end, silentGap)
  const parts = [
    speed.output,
    speed.output && speed.ttft ? `TTFT ${speed.ttft}` : undefined,
    speed.split,
    speed.note,
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : undefined
}

/** Includes tools, waits and every request of the turn, unlike a single request's output speed. */
export function turnSpeed(
  tokens: number,
  start: number,
  end: number,
  estimated: boolean,
): string | undefined {
  const speed = measuredRate(tokens, end - start)
  return speed === undefined
    ? undefined
    : `effective ${estimated ? "~" : ""}${rate(speed)} tok/s (includes tools and waits)`
}

/** Advances request timing without treating empty structural events as visible text. */
export function streamTiming(t: ReplyTiming, data: EventMap["message.stream"], ts: number): ReplyTiming {
  if (data.kind === "request") return { start: ts, thinkingDisplay: data.thinkingDisplay, thinkingBlocks: [] }
  if (data.kind === "end") t.last = ts
  else {
    if (data.kind !== "thinkingEnd") t.first ??= ts
    if (data.kind === "thinkingStart") {
      if (t.thinkingBlocks?.some((b) => b.end === undefined && b.index === data.index))
        t.splitIncomplete = true
      t.thinkingBlocks ??= []
      t.thinkingBlocks.push({ index: data.index, start: ts })
    }
    if (data.kind === "thinkingEnd") {
      const block = t.thinkingBlocks?.findLast((b) => b.end === undefined && b.index === data.index)
      if (block) block.end = ts
      else t.splitIncomplete = true
    }
  }
  return t
}
