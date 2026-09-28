// Ids made up for calls the server sent without one must not repeat across replies: the agent
// and the wire formats pair calls with results by id, so a repeat would mix up two steps.
import { expect, test } from "bun:test"
import { openaiResponses } from "../src/dialects/openai-responses.ts"
import type { StreamEvent } from "../src/types.ts"
import {
  anthropicAi,
  anthropicRequest,
  anthropicResponse,
  blockStart,
  blockStop,
  messageDelta,
  messageStart,
  messageStop,
} from "./anthropic-helpers.ts"
import { namedSSE, req, run, sse } from "./dialect-helpers.ts"
import { delta, events, fakeFetch, request, sseResponse, testAi } from "./helpers.ts"

function callIds(evs: StreamEvent[]): string[] {
  const done = evs.at(-1)
  if (done?.type !== "done") throw new Error(`expected done, got ${done?.type}`)
  return done.message.content.flatMap((b) => (b.type === "toolCall" ? [b.id] : []))
}

async function twice(reply: () => Promise<StreamEvent[]>) {
  const [a, b] = [callIds(await reply()), callIds(await reply())]
  expect(a).toHaveLength(1)
  expect(b).toHaveLength(1)
  expect(a[0]).not.toBe(b[0])
}

test("openai-chat: made-up call ids differ between replies", async () => {
  await twice(() => {
    const ai = testAi(
      fakeFetch(() =>
        sseResponse([
          delta({ tool_calls: [{ index: 0, function: { name: "read", arguments: "{}" } }] }),
          delta({}, "tool_calls"),
        ]),
      ),
    )
    return events(ai.stream(request(ai)))
  })
})

test("anthropic: made-up call ids differ between replies", async () => {
  await twice(() => {
    const ai = anthropicAi(
      fakeFetch(() =>
        anthropicResponse([
          messageStart(),
          blockStart(0, { type: "tool_use", name: "read", input: {} }),
          blockStop(0),
          messageDelta("tool_use"),
          messageStop,
        ]),
      ),
    )
    return events(ai.stream(anthropicRequest(ai)))
  })
})

test("openai-responses: made-up call ids differ between replies", async () => {
  const item = { type: "function_call", status: "completed", name: "read", arguments: "{}" }
  const chunks: { type: string; [k: string]: unknown }[] = [
    { type: "response.created", response: { id: "r", status: "in_progress", output: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
  ]
  const body = namedSSE(chunks)
  await twice(async () => (await run(openaiResponses, req("openai-responses"), () => sse(body))).evs)
})
