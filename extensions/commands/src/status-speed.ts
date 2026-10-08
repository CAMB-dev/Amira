import type { AnyEvent, EventEnvelope, EventMap, ExtensionAPI } from "@amira/api"
import {
  outputTokens,
  type ReplyTiming,
  type RequestSpeed,
  requestSpeed,
  streamTiming,
  turnSpeed,
} from "./speed.ts"

/** Installs dialect-neutral timing collection; never includes a child session's events. */
export function trackSpeed(api: Pick<ExtensionAPI, "onEvents">): (sessionId: string) => string[][] {
  const handlers = new Map<keyof EventMap, (e: AnyEvent) => void>()
  const on = <K extends keyof EventMap>(type: K, handler: (e: EventEnvelope<K>) => void) => {
    handlers.set(type, (e) => handler(e as EventEnvelope<K>))
  }
  const timing = new Map<string, ReplyTiming>()
  const speed = new Map<string, RequestSpeed>()
  const turns = new Map<string, { start: number; tokens: number; estimated: boolean }>()
  const effective = new Map<string, string>()
  const ended = new Set<string>()
  const chars = new Map<string, number>()
  on("turn.start", (e) => {
    if (e.parentSessionId !== undefined) return
    turns.set(e.sessionId, { start: e.data.sentAt ?? e.ts, tokens: 0, estimated: false })
  })
  on("message.start", (e) => {
    if (e.parentSessionId !== undefined) return
    timing.set(e.sessionId, { start: e.ts })
    chars.set(e.sessionId, 0)
    ended.delete(e.sessionId)
  })
  on("message.stream", (e) => {
    if (e.parentSessionId !== undefined) return
    const t = timing.get(e.sessionId)
    if (!t) return
    timing.set(e.sessionId, streamTiming(t, e.data, e.ts))
    if (e.data.kind === "request") {
      chars.set(e.sessionId, 0)
      ended.delete(e.sessionId)
    }
    if (e.data.kind === "end") {
      const turn = turns.get(e.sessionId)
      if (turn) {
        turn.tokens += e.data.outputTokens ?? Math.ceil((chars.get(e.sessionId) ?? 0) / 4)
        turn.estimated ||= e.data.outputTokens === undefined
      }
      ended.add(e.sessionId)
    }
  })
  on("message.delta", (e) => {
    if (e.parentSessionId !== undefined) return
    const t = timing.get(e.sessionId)
    if (!t) return
    t.first ??= e.ts
    const data = e.data
    if (data.kind === "thinking") {
      if (data.text) t.thinking ??= e.ts
    } else if (data.kind === "toolCall" ? data.argsDelta : data.kind === "text" && data.text) t.reply ??= e.ts
    const text = data.kind === "toolCall" ? data.argsDelta : "text" in data ? data.text : ""
    chars.set(e.sessionId, (chars.get(e.sessionId) ?? 0) + text.length)
  })
  on("message.end", (e) => {
    if (e.parentSessionId !== undefined) return
    const t = timing.get(e.sessionId)
    timing.delete(e.sessionId)
    speed.delete(e.sessionId)
    if (t) speed.set(e.sessionId, requestSpeed(e.data.message, t, e.ts))
    const turn = turns.get(e.sessionId)
    if (turn && !ended.has(e.sessionId)) {
      const count = outputTokens(e.data.message)
      turn.tokens += count.tokens
      turn.estimated ||= count.estimated
    }
    ended.delete(e.sessionId)
    chars.delete(e.sessionId)
  })
  on("compact.end", (e) => {
    if (e.parentSessionId !== undefined || e.turnId === undefined) return
    const turn = turns.get(e.sessionId)
    if (turn) {
      turn.tokens +=
        e.data.usage?.output ?? (e.data.model || e.data.native ? Math.ceil(e.data.summary.length / 4) : 0)
      turn.estimated ||= !!e.data.usageIncomplete || (!e.data.usage && !!(e.data.model || e.data.native))
    }
  })
  on("compact.failed", (e) => {
    if (e.parentSessionId !== undefined || e.turnId === undefined) return
    const turn = turns.get(e.sessionId)
    if (turn) {
      turn.tokens += e.data.usage?.output ?? 0
      turn.estimated ||= !!e.data.usageIncomplete || (!!e.data.requested && !e.data.usage)
    }
  })
  on("turn.end", (e) => {
    if (e.parentSessionId !== undefined) return
    const turn = turns.get(e.sessionId)
    turns.delete(e.sessionId)
    effective.delete(e.sessionId)
    if (turn) {
      const tps = turnSpeed(turn.tokens, turn.start, e.ts, turn.estimated)
      if (tps !== undefined) effective.set(e.sessionId, tps)
    }
  })
  on("events.lost", (e) => {
    // Incomplete intervals or usage cannot support an exact rate. Wait for fresh events.
    timing.delete(e.sessionId)
    speed.delete(e.sessionId)
    turns.delete(e.sessionId)
    effective.delete(e.sessionId)
    ended.delete(e.sessionId)
    chars.delete(e.sessionId)
  })
  // Separate subscriptions have independent queues: boundaries and end must share one.
  api.onEvents?.([...handlers.keys()], (e) => handlers.get(e.type)?.(e))
  return (sessionId) => {
    const last = speed.get(sessionId)
    const turn = effective.get(sessionId)
    return [
      [
        "Speed",
        last?.output || last?.ttft
          ? `${last.output ?? "output speed unavailable"} · TTFT ${last.ttft ?? "unknown"} (last request)${last.note ? `; ${last.note}` : ""}`
          : "not measured yet",
      ],
      ...(last?.split ? [["Split", last.split]] : []),
      ["Turn speed", turn ? `${turn} (last turn)` : "not measured yet"],
    ]
  }
}
