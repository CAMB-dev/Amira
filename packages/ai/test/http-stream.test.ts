import { expect, test } from "bun:test"
import { postStream } from "../src/dialects/http-stream.ts"
import type { AssistantMessage, ModelError, StreamEvent } from "../src/types.ts"
import { ctx, sse } from "./dialect-helpers.ts"
import { type ErrorEvent, events } from "./helpers.ts"

function acc() {
  const message: AssistantMessage = { role: "assistant", content: [], model: { provider: "t", model: "m" } }
  return {
    message,
    fail: (error: ModelError, retryable: boolean): ErrorEvent => {
      message.stopReason = "error"
      return { type: "error", error, retryable, message }
    },
  }
}

function drive(reader: () => AsyncGenerator<StreamEvent>) {
  return events(
    postStream({
      ctx: ctx(() => sse("data: {}\n\n")),
      acc: acc(),
      url: "http://test/x",
      headers: {},
      body: {},
      readSSE: reader,
      readPlain: reader,
    }),
  )
}

test("a reader that returns without a terminal event still ends with one retryable error", async () => {
  const evs = await drive(async function* () {
    yield { type: "start" }
  })
  expect(evs.map((e) => e.type)).toEqual(["request.start", "start", "error"])
  expect((evs.at(-1) as ErrorEvent).retryable).toBe(true)
})

test("events a reader yields after its terminal event are dropped", async () => {
  const a = acc()
  const evs = await drive(async function* () {
    yield { type: "done", message: a.message }
    yield a.fail({ message: "late" }, false)
  })
  expect(evs.map((e) => e.type)).toEqual(["request.start", "done"])
})
