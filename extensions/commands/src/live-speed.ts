import { DEFAULT_TUI_TOKEN_SPEED, type ExtensionAPI } from "@amira/api"
import { estimateChars, outputTokens, type ReplyTiming, rate, tokensPerSecond } from "./speed.ts"
import type { SpeedObserver } from "./status-speed.ts"

/** The live bar shares /status's ordered collector, but estimates only visible reply deltas. */
export function liveSpeed(
  api: Pick<ExtensionAPI, "settings" | "registerStatusItem" | "requestRender" | "onExit">,
): SpeedObserver | undefined {
  if (!(api.settings.tui?.tokenSpeed ?? DEFAULT_TUI_TOKEN_SPEED)) return
  let active:
    | { sessionId: string; timing: ReplyTiming; chars: number; first?: number; streaming: boolean }
    | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let last = ""
  let text = ""
  const show = (value: string) => {
    if (text === value) return
    text = value
    api.requestRender()
  }
  const estimate = (now: number) => {
    if (!active || active.first === undefined || now - active.first < 500) return ""
    const speed = tokensPerSecond(estimateChars(active.chars), active.first, now)
    return speed === undefined ? "" : `~${rate(speed)} tok/s`
  }
  const refresh = () => {
    if (!active) return
    // Keep the last rate between requests until new content starts streaming.
    if (!active.streaming && last) return show(last)
    const thinking = active.timing.thinkingBlocks?.find((b) => b.end === undefined)?.start
    if (thinking !== undefined || active.first === undefined) {
      const seconds = Math.max(0, Date.now() - (thinking ?? active.timing.start)) / 1000
      return show(`thinking ${seconds < 10 ? seconds.toFixed(1) : Math.floor(seconds)}s`)
    }
    show(estimate(Date.now()))
  }
  const stop = () => {
    clearInterval(timer)
    timer = undefined
  }
  const finish = (now: number) => {
    last = estimate(now) || last
    stop()
    show(last)
  }
  api.registerStatusItem({ id: "token-speed", align: "right", priority: 0, tone: "muted", text: () => text })
  api.onExit(stop)
  return (e, timing, speed) => {
    if (e.parentSessionId !== undefined) return
    if (e.type === "session.start" || e.type === "events.lost") {
      stop()
      active = undefined
      last = ""
      return show("")
    }
    if (e.type === "message.start" || (e.type === "message.stream" && e.data.kind === "request")) {
      if (!timing) return
      active = { sessionId: e.sessionId, timing, chars: 0, streaming: false }
      stop()
      timer = setInterval(refresh, 250)
      timer.unref()
      return refresh()
    }
    if (!active || active.sessionId !== e.sessionId) return
    if (timing) active.timing = timing
    if (e.type === "message.delta") {
      const delta = e.data.kind === "text" ? e.data.text : e.data.kind === "toolCall" ? e.data.argsDelta : ""
      if (delta) {
        active.first ??= e.ts
        active.chars += delta.length
        active.streaming = true
      } else if (e.data.kind === "thinking" && e.data.text) active.streaming = true
    } else if (e.type === "message.stream") {
      if (e.data.kind === "thinkingStart") active.streaming = true
      if (e.data.kind === "end") finish(e.ts)
    } else if (e.type === "message.end") {
      finish(active.timing.last ?? e.ts)
      if (!outputTokens(e.data.message).estimated) last = speed?.output?.replace(/^output /, "") ?? ""
      active = undefined
      show(last)
    } else if (e.type === "turn.end" || e.type === "session.end") {
      finish(active.timing.last ?? e.ts)
      active = undefined
    }
  }
}
