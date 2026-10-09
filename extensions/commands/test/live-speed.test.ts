import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import type { AssistantMessage, EventMap, ExtensionAPI, StatusItem } from "@amira/api"
import { EventBus } from "../../../packages/core/src/event-bus.ts"
import { liveSpeed } from "../src/live-speed.ts"
import { trackSpeed } from "../src/status-speed.ts"

const model = { provider: "mock", model: "test" }
const message = (output?: number): AssistantMessage => ({
  role: "assistant",
  model,
  content: [{ type: "text", text: "x".repeat(80) }],
  ...(output === undefined ? {} : { usage: { input: 0, output, cacheRead: 0, cacheWrite: 0 } }),
})
let now = 0
let tick: (() => void) | undefined
let clock: ReturnType<typeof spyOn<typeof Date, "now">>
let interval: ReturnType<typeof spyOn<typeof globalThis, "setInterval">>
let clear: ReturnType<typeof spyOn<typeof globalThis, "clearInterval">>

beforeEach(() => {
  now = 0
  tick = undefined
  clock = spyOn(Date, "now").mockImplementation(() => now)
  interval = spyOn(globalThis, "setInterval").mockImplementation((...args: unknown[]) => {
    tick = args[0] as () => void
    return { unref() {} } as ReturnType<typeof setInterval>
  })
  clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {
    tick = undefined
  })
})
afterEach(() => {
  clock.mockRestore()
  interval.mockRestore()
  clear.mockRestore()
})

function setup(enabled?: boolean) {
  const bus = new EventBus()
  let item: StatusItem | undefined
  let exit: (() => void) | undefined
  const render = mock(() => {})
  const api: Pick<ExtensionAPI, "onEvents" | "settings" | "registerStatusItem" | "requestRender" | "onExit"> =
    {
      settings: { tui: enabled === undefined ? {} : { tokenSpeed: enabled }, layers: () => [] },
      onEvents: (types, handler) => bus.subscribe(handler, { types: [...types] }),
      registerStatusItem: (value) => {
        item = value
        return () => {}
      },
      requestRender: render,
      onExit: (handler) => {
        exit = () => handler(new AbortController().signal)
        return () => {}
      },
    }
  const rows = trackSpeed(api, liveSpeed(api))
  const emit = async <K extends keyof EventMap>(ts: number, type: K, data: EventMap[K], child = false) => {
    now = ts
    bus.emit(type, data, { sessionId: "main", ...(child ? { parentSessionId: "parent" } : {}) })
    await bus.flush()
  }
  const advance = (ts: number) => {
    now = ts
    tick?.()
  }
  const start = async (ts = 0) => {
    await emit(ts, "message.start", { model })
    await emit(ts, "message.stream", { kind: "request" })
  }
  return {
    emit,
    advance,
    start,
    text: () => item?.text(),
    item: () => item,
    render,
    rows,
    exit: () => exit?.(),
  }
}

test.each(["text", "toolCall"] as const)("%s deltas show a throttled estimate after 500 ms", async (kind) => {
  const s = setup()
  await s.start()
  await s.emit(100, "message.stream", { kind: "contentStart" })
  await s.emit(100, "message.delta", { kind: "text", text: "" })
  s.advance(800)
  expect(s.text()).toBe("thinking 0.8s")
  const renders = s.render.mock.calls.length
  await s.emit(
    1000,
    "message.delta",
    kind === "text"
      ? { kind, text: "x".repeat(80) }
      : { kind, toolCallId: "tool", argsDelta: "x".repeat(80) },
  )
  expect(s.render.mock.calls.length).toBe(renders)
  s.advance(1499)
  expect(s.text()).toBe("")
  s.advance(1500)
  expect(s.text()).toBe("~40 tok/s")
  await s.emit(1600, "message.delta", { kind: "text", text: "x".repeat(40) })
  expect(s.text()).toBe("~40 tok/s")
  s.advance(2000)
  expect(s.text()).toBe("~30 tok/s")
  expect(s.item()).toMatchObject({ align: "right", priority: 0, tone: "muted" })
  expect(interval.mock.calls.every((call) => call[1] === 250)).toBe(true)
})

test("thinking shows elapsed time, never speed from bursty summaries", async () => {
  const s = setup()
  await s.start()
  s.advance(1250)
  expect(s.text()).toBe("thinking 1.3s")
  await s.emit(2000, "message.stream", { kind: "thinkingStart", index: 0 })
  await s.emit(2500, "message.delta", { kind: "thinking", text: "x".repeat(4000) })
  s.advance(3500)
  expect(s.text()).toBe("thinking 1.5s")
  s.advance(12_500)
  expect(s.text()).toBe("thinking 10s")
  await s.emit(13_000, "message.stream", { kind: "thinkingEnd", index: 0 })
  await s.emit(14_000, "message.delta", { kind: "text", text: "x".repeat(80) })
  s.advance(14_500)
  expect(s.text()).toBe("~40 tok/s")
})

test("message end replaces the estimate with /status's exact rate, retained while idle and waiting", async () => {
  const s = setup()
  await s.start()
  await s.emit(500, "message.stream", { kind: "contentStart" })
  await s.emit(1000, "message.delta", { kind: "text", text: "x".repeat(80) })
  s.advance(1500)
  expect(s.text()).toBe("~40 tok/s")
  await s.emit(2500, "message.stream", { kind: "end", outputTokens: 364 })
  expect(tick).toBeUndefined()
  await s.emit(5000, "message.end", { message: message(364) })
  expect(s.text()).toBe("182 tok/s")
  expect(s.rows("main")[0]?.[1]).toContain("output 182 tok/s")
  await s.emit(6000, "turn.end", { reason: "done", steps: 1 })
  const renders = s.render.mock.calls.length
  s.advance(10_000)
  expect(s.text()).toBe("182 tok/s")
  expect(s.render.mock.calls.length).toBe(renders)
  await s.start(11_000)
  s.advance(12_000)
  expect(s.text()).toBe("182 tok/s")
  await s.emit(12_000, "message.delta", { kind: "text", text: "x".repeat(40) })
  s.advance(12_500)
  expect(s.text()).toBe("~20 tok/s")
})

test.each([false, true])(
  "missing reported usage keeps the visible estimate (usage object: %s)",
  async (usageObject) => {
    const s = setup()
    await s.start()
    await s.emit(100, "message.delta", { kind: "thinking", text: "x".repeat(4000) })
    await s.emit(1000, "message.delta", { kind: "text", text: "x".repeat(80) })
    s.advance(1500)
    expect(s.text()).toBe("~40 tok/s")
    await s.emit(2000, "message.stream", { kind: "end" })
    const reply = message(usageObject ? 0 : undefined)
    if (reply.usage) reply.usage.outputReported = false
    await s.emit(5000, "message.end", { message: reply })
    expect(s.text()).toBe("~20 tok/s")
    expect(tick).toBeUndefined()
    s.advance(20_000)
    expect(s.text()).toBe("~20 tok/s")
  },
)

test("disabled setting registers no item, timer or render requests", async () => {
  const s = setup(false)
  await s.start()
  await s.emit(1000, "message.delta", { kind: "text", text: "answer" })
  s.advance(2000)
  await s.emit(3000, "message.end", { message: message(100) })
  expect(s.item()).toBeUndefined()
  expect(interval).not.toHaveBeenCalled()
  expect(s.render).not.toHaveBeenCalled()
})

test("child events cannot start, stop, reset or finalize the main speed", async () => {
  const s = setup()
  await s.emit(0, "message.start", { model }, true)
  expect(interval).not.toHaveBeenCalled()
  await s.start()
  await s.emit(1000, "message.delta", { kind: "text", text: "x".repeat(80) })
  await s.emit(1100, "message.stream", { kind: "request" }, true)
  await s.emit(1200, "message.delta", { kind: "text", text: "x".repeat(8000) }, true)
  await s.emit(1300, "message.stream", { kind: "thinkingStart" }, true)
  await s.emit(1400, "message.stream", { kind: "end", outputTokens: 9999 }, true)
  await s.emit(1400, "message.end", { message: message(9999) }, true)
  await s.emit(1400, "events.lost", { dropped: 1 }, true)
  await s.emit(1400, "session.end", { reason: "exit" }, true)
  expect(tick).toBeDefined()
  s.advance(1500)
  expect(s.text()).toBe("~40 tok/s")
})

test.each(["turn.end", "session.end", "events.lost", "session.start"] as const)(
  "%s stops an unfinished request's timer",
  async (type) => {
    const s = setup()
    await s.start()
    expect(tick).toBeDefined()
    if (type === "turn.end") await s.emit(1000, type, { reason: "aborted", steps: 0 })
    else if (type === "session.end") await s.emit(1000, type, { reason: "switch" })
    else if (type === "events.lost") await s.emit(1000, type, { dropped: 1 })
    else await s.emit(1000, type, { model, cwd: "/tmp", reason: "startup" })
    expect(tick).toBeUndefined()
    expect(s.text()).toBe("")
  },
)

test("retries reset the visible interval, and exit stops the timer", async () => {
  const s = setup()
  await s.start()
  await s.emit(1000, "message.delta", { kind: "text", text: "x".repeat(800) })
  s.advance(1500)
  expect(s.text()).toBe("~400 tok/s")
  await s.emit(2000, "message.stream", { kind: "end" })
  await s.emit(3000, "message.stream", { kind: "request" })
  await s.emit(4000, "message.delta", { kind: "text", text: "x".repeat(40) })
  s.advance(4500)
  expect(s.text()).toBe("~20 tok/s")
  s.exit()
  expect(tick).toBeUndefined()
})
