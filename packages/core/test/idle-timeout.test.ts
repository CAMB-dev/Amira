import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"

test("a provider stalled after visible content preserves the idle hint through the turn error and TUI detail", async () => {
  let release!: () => void
  const until = new Promise<void>((resolve) => {
    release = resolve
  })
  const mock = createMockDialect([{ text: "partial answer", hold: { chunks: 1, until } }, { text: "resent" }])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 2, baseDelayMs: 1, firstContentTimeoutMs: 1000, idleTimeoutMs: 20 },
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const agent = new Agent({ ai, model: ai.model("mock/test"), cwd: process.cwd(), systemPrompt: "", bus })
  const error = "model stream was idle for 20 ms. Type a message to continue, or press ↑ to resend."
  try {
    const result = await agent.prompt("go")
    await bus.flush()
    expect(mock.requests).toHaveLength(1)
    expect(result).toMatchObject({
      reason: "error",
      steps: 1,
      error,
      failure: {
        summary: "Model stream was idle for 20 ms",
        hint: "Type a message to continue, or press ↑ to resend.",
        detail: error,
      },
    })
    expect(events.filter((e) => e.type === "model.retry")).toEqual([])
    expect(events.find((e) => e.type === "turn.end")).toMatchObject({
      data: { reason: "error", steps: 1, error, failure: { detail: error } },
    })
    expect(events.find((e) => e.type === "status.changed" && e.data.status === "error")).toMatchObject({
      data: { status: "error", reason: error },
    })
    expect(events.find((e) => e.type === "message.end")).toMatchObject({
      data: { message: { content: [{ type: "text", text: "partial " }], stopReason: "error" } },
    })
    expect(agent.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "partial " }],
      stopReason: "error",
    })
    expect(agent.status).toBe("idle")
    expect(agent.noticeRetry).toBeUndefined()
  } finally {
    release()
    await agent.dispose("exit")
  }
})
