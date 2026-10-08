import { expect, spyOn, test } from "bun:test"
import { createAi, type Dialect, type StreamEvent } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { modelCall } from "../src/agent/model-call.ts"
import { EventBus } from "../src/event-bus.ts"

test("model calls forward structural provider boundaries and preserve the final event time", async () => {
  const clock = spyOn(Date, "now")
  const message = {
    role: "assistant" as const,
    model: { provider: "fake", model: "m" },
    content: [],
    usage: { input: 0, output: 856, reasoning: 195, cacheRead: 0, cacheWrite: 0 },
  }
  const sequence: [number, StreamEvent][] = [
    [0, { type: "request.start", thinkingDisplay: "omitted" }],
    [760, { type: "content.start", index: 0 }],
    [760, { type: "thinking.start", index: 0 }],
    [760, { type: "thinking.delta", text: "" }],
    [1930, { type: "thinking.end", index: 0 }],
    [1930, { type: "content.start", index: 1 }],
    [1930, { type: "text.delta", text: "answer" }],
    [6020, { type: "done", message }],
  ]
  const dialect: Dialect = {
    id: "fake",
    async *stream() {
      for (const [ts, event] of sequence) {
        clock.mockReturnValue(ts)
        yield event
      }
    },
  }
  const ai = createAi({
    dialects: [dialect],
    providers: [{ id: "fake", dialect: "fake", baseUrl: "http://fake" }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const seen: AnyEvent[] = []
  bus.subscribe((event) => {
    seen.push(event)
  })
  try {
    await modelCall({
      ai,
      model: ai.model("fake/m"),
      modelRef: message.model,
      systemPrompt: "",
      messages: [],
      tools: () => [],
      signal: new AbortController().signal,
      emit: (type, data) => {
        bus.emit(type, data, { sessionId: "s" })
      },
    })
    await bus.flush()
    expect(seen.map((e) => [e.ts, e.type, "kind" in e.data ? e.data.kind : ""])).toEqual([
      [0, "message.stream", "request"],
      [760, "message.stream", "contentStart"],
      [760, "message.stream", "thinkingStart"],
      [760, "message.delta", "thinking"],
      [1930, "message.stream", "thinkingEnd"],
      [1930, "message.stream", "contentStart"],
      [1930, "message.delta", "text"],
      [6020, "message.stream", "end"],
    ])
    expect(seen.at(-1)?.data).toMatchObject({ kind: "end", outputTokens: 856 })
  } finally {
    clock.mockRestore()
  }
})
