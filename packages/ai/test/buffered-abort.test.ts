import { expect, test } from "bun:test"
import type { Dialect } from "../src/dialect.ts"
import { anthropicMessages } from "../src/dialects/anthropic.ts"
import { googleGemini } from "../src/dialects/google-gemini.ts"
import { openaiChat } from "../src/dialects/openai-chat.ts"
import { openaiResponses } from "../src/dialects/openai-responses.ts"
import type { StreamEvent } from "../src/types.ts"
import {
  anthropicSSE,
  blockDelta,
  blockStart,
  blockStop,
  messageDelta,
  messageStart,
  messageStop,
} from "./anthropic-helpers.ts"
import { ctx, dataSSE, namedSSE, req } from "./dialect-helpers.ts"
import { delta, SSE_HEADERS, sseBody } from "./helpers.ts"

// Each reply is two text deltas and a successful end, all in the body's one and only chunk:
// the parser holds everything that follows the first delta before its consumer sees it.
const replies: [Dialect, string][] = [
  [openaiChat, sseBody([delta({ content: "first" }), delta({ content: " after" }), delta({}, "stop")])],
  [
    anthropicMessages,
    anthropicSSE([
      messageStart(),
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "first" }),
      blockDelta(0, { type: "text_delta", text: " after" }),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop,
    ]),
  ],
  [
    openaiResponses,
    namedSSE([
      { type: "response.output_text.delta", item_id: "m", delta: "first" } as { type: string },
      { type: "response.output_text.delta", item_id: "m", delta: " after" } as { type: string },
      { type: "response.completed", response: {} } as { type: string },
    ]),
  ],
  [
    googleGemini,
    dataSSE([
      { candidates: [{ content: { role: "model", parts: [{ text: "first" }] }, index: 0 }] },
      {
        candidates: [
          { content: { role: "model", parts: [{ text: " after" }] }, finishReason: "STOP", index: 0 },
        ],
      },
    ]),
  ],
]

for (const [dialect, body] of replies) {
  test(`${dialect.id}: an abort while a buffered chunk is read ends the stream aborted`, async () => {
    const ac = new AbortController()
    const seen: StreamEvent[] = []
    const res = () => new Response(body, { headers: SSE_HEADERS })
    for await (const ev of dialect.stream(req(dialect.id), ctx(res, {}, ac.signal))) {
      seen.push(ev)
      if (ev.type === "text.delta") ac.abort()
    }
    expect(seen.filter((e) => e.type === "text.delta").map((e) => e.type === "text.delta" && e.text)).toEqual(
      ["first"],
    )
    const last = seen.at(-1)
    expect(last?.type).toBe("error")
    if (last?.type !== "error") return
    expect(last.error.code).toBe("aborted")
    expect(last.message.stopReason).toBe("aborted")
    expect(last.message.content).toEqual([{ type: "text", text: "first" }])
  })
}
