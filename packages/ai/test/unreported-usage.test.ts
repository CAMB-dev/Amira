import { expect, test } from "bun:test"
import { MessagesAccumulator } from "../src/dialects/anthropic-accumulate.ts"
import { GeminiAccumulator } from "../src/dialects/google-gemini-accumulate.ts"
import { ChatAccumulator } from "../src/dialects/openai-chat-accumulate.ts"
import { ResponsesAccumulator } from "../src/dialects/openai-responses-accumulate.ts"

const model = { provider: "fake", model: "m" }

test.each([
  () => new MessagesAccumulator(model),
  () => new GeminiAccumulator(model),
  () => new ChatAccumulator(model),
  () => new ResponsesAccumulator(model),
])("missing provider usage is not fabricated as reported zero", (create) => {
  const acc = create()
  expect(acc.message.usage).toBeUndefined()
  acc.end()
  expect(acc.message.usage).toBeUndefined()
})

test("a provider's explicit zero output remains reported", () => {
  const acc = new MessagesAccumulator(model)
  Array.from(acc.apply({ type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } }))
  acc.end()
  expect(acc.message.usage?.output).toBe(0)
})

test("Gemini preserves reported search counts without pretending its output count was reported", () => {
  for (const reportOutput of [false, true]) {
    const acc = new GeminiAccumulator({ provider: "fake", model: "gemini-3-pro" })
    Array.from(acc.apply({ candidates: [{ groundingMetadata: { webSearchQueries: ["query"] } }] }))
    if (reportOutput)
      Array.from(acc.apply({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }))
    acc.end()
    expect(acc.message.usage?.webSearchRequests).toBe(1)
    expect(acc.message.usage?.outputReported).toBe(reportOutput ? undefined : false)
    expect(acc.message.usage?.output).toBe(reportOutput ? 2 : 0)
  }
})
