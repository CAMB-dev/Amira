import { expect, test } from "bun:test"
import { type AssistantMessage, createAi, emptyUsage, type StreamEvent } from "@amira/ai"
import { modelCall } from "../src/agent/model-call.ts"

const ended: AssistantMessage = {
  role: "assistant",
  model: { provider: "mock", model: "test" },
  content: [
    { type: "text", text: "partial" },
    { type: "toolCall", id: "t", name: "unused", args: {} },
  ],
  usage: { ...emptyUsage(), input: 20, output: 2, cost: 0.2 },
}

for (const terminal of ["request.end", "done"] as const) {
  test(`model call snapshots ${terminal} usage before adapter cleanup can mutate it`, async () => {
    const base = createAi({ providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
    const message = structuredClone(ended)
    const result = await modelCall({
      ai: {
        ...base,
        async *stream(): AsyncGenerator<StreamEvent> {
          yield { type: terminal, message }
          message.usage!.cost = 0
          throw new Error("cleanup changed its reused object")
        },
      },
      model: base.model("mock/test"),
      modelRef: ended.model,
      systemPrompt: "",
      messages: [],
      tools: () => [],
      signal: new AbortController().signal,
      emit: () => {},
    })
    expect(result.message.usage?.cost).toBe(0.2)
  })
}

for (const outputReported of [undefined, false]) {
  for (const abort of [false, true]) {
    for (const terminal of ["throw", "error", "done", "missing"] as const) {
      test(`model call preserves ${outputReported === false ? "partial" : "full"} request.end usage after ${terminal} (${abort ? "aborted" : "error"})`, async () => {
        const signal = new AbortController()
        const base = createAi({ providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
        const result = await modelCall({
          ai: {
            ...base,
            async *stream(): AsyncGenerator<StreamEvent> {
              yield {
                type: "request.end",
                message: { ...structuredClone(ended), usage: { ...ended.usage!, outputReported } },
              }
              if (abort) signal.abort()
              if (terminal === "throw") throw new Error("adapter failure")
              if (terminal === "missing") return
              const message: AssistantMessage = { ...structuredClone(ended), usage: undefined }
              if (terminal === "done") yield { type: "done", message }
              else yield { type: "error", error: { message: "adapter failure" }, retryable: false, message }
            },
          },
          model: base.model("mock/test"),
          modelRef: ended.model,
          systemPrompt: "",
          messages: [],
          tools: () => [],
          signal: signal.signal,
          emit: () => {},
          recordAttempt: () => {
            throw new Error("the same physical attempt must not be booked twice")
          },
        })
        expect(result.message.usage?.cost).toBeCloseTo(0.2)
        expect(result.message.usage?.input).toBe(20)
        expect(result.message.usage?.outputReported).toBe(outputReported)
        expect(result.aborted).toBe(abort)
        if (abort || terminal !== "done") {
          expect(result.message.content).toEqual([{ type: "text", text: "partial" }])
        }
        if (!abort && terminal !== "done")
          expect(result.error).toBe(
            terminal === "missing" ? "the model stream ended without a final message" : "adapter failure",
          )
      })
    }
  }
}
