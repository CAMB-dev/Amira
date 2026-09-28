import { createAi } from "../src/client.ts"
import type { ModelRequest } from "../src/types.ts"
import { SSE_HEADERS } from "./helpers.ts"

/** An Anthropic event stream: each event carries its type as both `event:` and `data.type`. */
export function anthropicSSE(events: { type: string; [k: string]: unknown }[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")
}

export function anthropicResponse(events: { type: string; [k: string]: unknown }[]): Response {
  return new Response(anthropicSSE(events), { headers: SSE_HEADERS })
}

export const messageStart = (usage: Record<string, number> = { input_tokens: 10, output_tokens: 1 }) => ({
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [],
    model: "claude",
    stop_reason: null,
    usage,
  },
})

export const blockStart = (index: number, content_block: Record<string, unknown>) => ({
  type: "content_block_start",
  index,
  content_block,
})

export const blockDelta = (index: number, delta: Record<string, unknown>) => ({
  type: "content_block_delta",
  index,
  delta,
})

export const blockStop = (index: number) => ({ type: "content_block_stop", index })

export const messageDelta = (stop_reason: string, usage: Record<string, number> = { output_tokens: 5 }) => ({
  type: "message_delta",
  delta: { stop_reason, stop_sequence: null },
  usage,
})

export const messageStop = { type: "message_stop" }

/** A whole reply made of one text block. */
export function textReply(text: string, stop = "end_turn") {
  return [
    messageStart(),
    blockStart(0, { type: "text", text: "" }),
    blockDelta(0, { type: "text_delta", text }),
    blockStop(0),
    messageDelta(stop),
    messageStop,
  ]
}

/** A client whose "anth" provider speaks anthropic-messages through the given fetch. */
export function anthropicAi(fetchImpl?: typeof fetch, baseUrl = "http://anth") {
  return createAi({
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    providers: [
      {
        id: "anth",
        dialect: "anthropic-messages",
        baseUrl,
        apiKey: "sk-test",
        models: [
          { id: "claude", maxOutput: 32_000, caps: { thinking: true, images: true, promptCache: true } },
        ],
      },
    ],
  })
}

export function anthropicRequest(
  ai: ReturnType<typeof createAi>,
  extra: Partial<ModelRequest> = {},
): ModelRequest {
  return { model: ai.model("anth/claude"), systemPrompt: "", messages: [], tools: [], ...extra }
}
