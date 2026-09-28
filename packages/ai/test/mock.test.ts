import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { collect } from "../src/dialect.ts"
import { createMockDialect, type MockStep } from "../src/dialects/mock.ts"
import type { ModelRequest, StreamEvent } from "../src/types.ts"
import { type ErrorEvent, events } from "./helpers.ts"

function setup(steps: MockStep[] = []) {
  const mock = createMockDialect(steps)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const req = (text = "q"): ModelRequest => ({
    model: ai.model("mock/m"),
    systemPrompt: "",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    tools: [],
  })
  return { mock, ai, req }
}

test("an abort during delayMs ends promptly with one aborted error", async () => {
  const { ai, req } = setup([{ text: "hello", delayMs: 5_000 }])
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 20)
  const t0 = performance.now()
  const evs = await events(ai.stream(req(), ac.signal))
  expect(performance.now() - t0).toBeLessThan(1_000)
  expect(evs).toHaveLength(1)
  const e = evs[0] as ErrorEvent
  expect(e.error.code).toBe("aborted")
  expect(e.message.stopReason).toBe("aborted")
})

test("push() appends steps after creation", async () => {
  const { mock, ai, req } = setup([{ text: "one" }])
  mock.push({ text: "two" }, { text: "three" })
  const texts = []
  for (let i = 0; i < 3; i++) {
    const msg = await collect(ai.stream(req()))
    texts.push(msg.content[0]?.type === "text" ? msg.content[0].text : "")
  }
  expect(texts).toEqual(["one", "two", "three"])
})

test("function steps see the request and requests are recorded", async () => {
  const { mock, ai, req } = setup([
    (r) => {
      const first = r.messages[0]
      return {
        text:
          first?.role === "user" && first.content[0]?.type === "text" ? `echo ${first.content[0].text}` : "",
      }
    },
  ])
  const msg = await collect(ai.stream(req("ping")))
  expect(msg.content).toEqual([{ type: "text", text: "echo ping" }])
  expect(mock.requests).toHaveLength(1)
  expect(mock.requests[0]?.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "ping" }] })
})

test("tool call deltas carry their index", async () => {
  const { ai, req } = setup([
    {
      toolCalls: [
        { name: "a", args: {} },
        { name: "b", args: "{bad" },
      ],
    },
  ])
  const evs = await events(ai.stream(req()))
  const deltas = evs.filter(
    (e): e is Extract<StreamEvent, { type: "toolCall.delta" }> => e.type === "toolCall.delta",
  )
  expect(deltas.map((d) => [d.index, d.name])).toEqual([
    [0, "a"],
    [1, "b"],
  ])
  const done = evs.at(-1)
  expect(done?.type === "done" && done.message.stopReason).toBe("toolUse")
})
