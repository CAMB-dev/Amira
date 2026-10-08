import { expect, spyOn, test } from "bun:test"
import type { AssistantMessage, EventMap, ExtensionAPI } from "@amira/api"
import { EventBus } from "../../../packages/core/src/event-bus.ts"
import { trackSpeed } from "../src/status-speed.ts"

const model = { provider: "anthropic", model: "claude-sonnet-5-5" }
const message = (output: number, reasoning?: number): AssistantMessage => ({
  role: "assistant",
  model,
  content: [{ type: "text", text: "answer" }],
  usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, ...(reasoning !== undefined ? { reasoning } : {}) },
})

function setup() {
  const bus = new EventBus()
  const api: Pick<ExtensionAPI, "onEvents"> = {
    onEvents: (types, handler) => bus.subscribe(handler, { types: [...types] }),
  }
  const rows = trackSpeed(api)
  const clock = spyOn(Date, "now")
  const emit = <K extends keyof EventMap>(ts: number, type: K, data: EventMap[K], child = false) => {
    clock.mockReturnValue(ts)
    bus.emit(type, data, { sessionId: "s1", turnId: "t1", ...(child ? { parentSessionId: "p" } : {}) })
  }
  return { bus, rows, clock, emit }
}

test.each([
  {
    display: "omitted" as const,
    first: 760,
    thoughtEnd: 1930,
    end: 6020,
    output: 856,
    reasoning: 195,
    rate: 163,
  },
  {
    display: "summarized" as const,
    first: 1380,
    thoughtEnd: 5070,
    end: 6530,
    output: 848,
    reasoning: 194,
    rate: 165,
  },
])("measured $display events produce exact output and only a valid split", async (run) => {
  const { bus, rows, clock, emit } = setup()
  try {
    emit(0, "turn.start", { prompt: { role: "user", content: [] } })
    emit(0, "message.start", { model })
    emit(0, "message.stream", { kind: "request", thinkingDisplay: run.display })
    emit(run.first, "message.stream", { kind: "contentStart", index: 0 })
    emit(run.first, "message.stream", { kind: "thinkingStart", index: 0 })
    emit(run.display === "omitted" ? run.first : 5060, "message.delta", {
      kind: "thinking",
      text: run.display === "omitted" ? "" : "summary",
    })
    emit(run.thoughtEnd, "message.stream", { kind: "thinkingEnd", index: 0 })
    emit(run.thoughtEnd, "message.stream", { kind: "contentStart", index: 1 })
    emit(run.thoughtEnd, "message.delta", { kind: "text", text: "answer" })
    emit(run.end, "message.stream", { kind: "end", outputTokens: run.output })
    // Deliberately delay message.end processing: it must not extend provider-stream time.
    emit(run.end + 500, "message.end", { message: message(run.output, run.reasoning) })
    emit(run.end + 1000, "turn.end", { reason: "done", steps: 1 })
    await bus.flush()
    const result = rows("s1")
    expect(result[0]?.[1]).toContain(`output ${run.rate} tok/s · TTFT ${(run.first / 1000).toFixed(2)}s`)
    if (run.display === "omitted")
      expect(result[1]).toEqual(["Split", "reply 162 tok/s · thinking 167 tok/s"])
    else {
      expect(result[0]?.[1]).toContain("summarized thinking; no split")
      expect(result.some(([label]) => label === "Split")).toBe(false)
    }
  } finally {
    clock.mockRestore()
  }
})

test("turn effective TPS includes multiple requests, tool time and the original prompt wait", async () => {
  const { bus, rows, clock, emit } = setup()
  try {
    emit(2000, "turn.start", { prompt: { role: "user", content: [] }, sentAt: 0 })
    for (const start of [2000, 8000]) {
      emit(start, "message.start", { model })
      emit(start, "message.stream", { kind: "request", thinkingDisplay: "raw" })
      emit(start + 1000, "message.delta", { kind: "toolCall", toolCallId: "t", argsDelta: "" })
      emit(start + 3000, "message.stream", { kind: "end", outputTokens: 200 })
      emit(start + 3000, "message.end", { message: message(200, 0) })
    }
    emit(12000, "turn.end", { reason: "done", steps: 2 })
    await bus.flush()
    expect(rows("s1")).toEqual([
      ["Speed", "output 100 tok/s · TTFT 1.00s (last request)"],
      ["Split", "reply 100 tok/s"],
      ["Turn speed", "effective 33 tok/s (includes tools and waits) (last turn)"],
    ])
  } finally {
    clock.mockRestore()
  }
})

test("retry attempts reset request TTFT and contribute their reported output only once", async () => {
  const { bus, rows, clock, emit } = setup()
  try {
    emit(0, "turn.start", { prompt: { role: "user", content: [] } })
    emit(0, "message.start", { model })
    emit(0, "message.stream", { kind: "request", thinkingDisplay: "raw" })
    emit(1000, "message.stream", { kind: "end", outputTokens: 20 })
    emit(2000, "message.stream", { kind: "request", thinkingDisplay: "raw" })
    emit(2500, "message.delta", { kind: "text", text: "answer" })
    emit(3000, "message.stream", { kind: "end", outputTokens: 80 })
    emit(3500, "message.end", { message: message(80) })
    emit(4000, "turn.end", { reason: "done", steps: 1 })
    await bus.flush()
    expect(rows("s1")[0]?.[1]).toBe("output 160 tok/s · TTFT 0.50s (last request)")
    expect(rows("s1").at(-1)?.[1]).toBe("effective 25 tok/s (includes tools and waits) (last turn)")
  } finally {
    clock.mockRestore()
  }
})

test("unreported output estimates are marked and child events never affect the parent", async () => {
  const { bus, rows, clock, emit } = setup()
  try {
    emit(0, "turn.start", { prompt: { role: "user", content: [] } })
    emit(0, "message.start", { model })
    emit(0, "message.stream", { kind: "request" })
    emit(1000, "message.delta", { kind: "text", text: "x".repeat(80) })
    emit(2000, "message.stream", { kind: "end" })
    const unreported = message(0)
    delete unreported.usage
    unreported.content = [{ type: "text", text: "x".repeat(80) }]
    emit(2000, "message.end", { message: unreported })
    emit(3000, "message.end", { message: message(99999) }, true)
    emit(4000, "turn.end", { reason: "done", steps: 1 })
    await bus.flush()
    expect(rows("s1")[0]?.[1]).toContain("output ~20 tok/s")
    expect(rows("s1").at(-1)?.[1]).toBe("effective ~5.0 tok/s (includes tools and waits) (last turn)")
  } finally {
    clock.mockRestore()
  }
})

test.each([true, false])("turn accounting includes failed compactions (reported: %s)", async (reported) => {
  const { bus, rows, clock, emit } = setup()
  try {
    emit(0, "turn.start", { prompt: { role: "user", content: [] } })
    emit(1000, "compact.failed", {
      error: "failed",
      requested: true,
      ...(reported ? { usage: message(100).usage } : { usageIncomplete: true }),
    })
    emit(3000, "message.start", { model })
    emit(3500, "message.delta", { kind: "text", text: "answer" })
    emit(4000, "message.end", { message: message(50) })
    emit(5000, "turn.end", { reason: "done", steps: 1 })
    await bus.flush()
    expect(rows("s1").at(-1)?.[1]).toBe(
      `effective ${reported ? "30" : "~10"} tok/s (includes tools and waits) (last turn)`,
    )
  } finally {
    clock.mockRestore()
  }
})

test("TTFT is retained for a zero-duration output interval", async () => {
  const { bus, rows, clock, emit } = setup()
  try {
    emit(0, "message.start", { model })
    emit(200, "message.delta", { kind: "text", text: "answer" })
    emit(200, "message.stream", { kind: "end", outputTokens: 50 })
    emit(300, "message.end", { message: message(50) })
    await bus.flush()
    expect(rows("s1")[0]?.[1]).toBe("output speed unavailable · TTFT 0.20s (last request)")
  } finally {
    clock.mockRestore()
  }
})

test("lost events invalidate the request and turn instead of reporting an exact partial rate", async () => {
  const { bus, rows, clock, emit } = setup()
  try {
    emit(0, "turn.start", { prompt: { role: "user", content: [] } })
    emit(0, "message.start", { model })
    emit(100, "message.delta", { kind: "text", text: "answer" })
    emit(1000, "events.lost", { dropped: 1 })
    emit(2000, "message.end", { message: message(50) })
    emit(3000, "turn.end", { reason: "done", steps: 1 })
    await bus.flush()
    expect(rows("s1")).toEqual([
      ["Speed", "not measured yet"],
      ["Turn speed", "not measured yet"],
    ])
  } finally {
    clock.mockRestore()
  }
})
