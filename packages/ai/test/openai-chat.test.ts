import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { collect } from "../src/dialect.ts"
import { toChatMessages } from "../src/dialects/openai-chat.ts"
import { INVALID_ARGS_KEY } from "../src/tool-args.ts"
import type { StreamEvent } from "../src/types.ts"

function sseResponse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

function fakeFetch(res: Response | (() => Response), seen: { url?: string; body?: any; headers?: any } = {}) {
  return (async (url: string, init: RequestInit) => {
    seen.url = url
    seen.body = JSON.parse(init.body as string)
    seen.headers = init.headers
    return typeof res === "function" ? res() : res
  }) as unknown as typeof fetch
}

const delta = (d: unknown, finish: string | null = null) => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
})

test("streams text, reasoning and usage", async () => {
  const seen: any = {}
  const ai = createAi({
    env: { DEEPSEEK_API_KEY: "k" },
    fetch: fakeFetch(
      sseResponse([
        delta({ reasoning_content: "think " }),
        delta({ content: "Hel" }),
        delta({ content: "lo" }, "stop"),
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 40 } },
      ]),
      seen,
    ),
  })
  const events: StreamEvent[] = []
  for await (const e of ai.stream({
    model: ai.model("deepseek/chat"),
    systemPrompt: "sys",
    messages: [],
    tools: [],
  }))
    events.push(e)

  expect(seen.url).toBe("https://api.deepseek.com/chat/completions")
  expect(seen.headers.authorization).toBe("Bearer k")
  expect(seen.body.messages[0]).toEqual({ role: "system", content: "sys" })
  expect(events.map((e) => e.type)).toEqual(["start", "thinking.delta", "text.delta", "text.delta", "done"])
  const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>
  expect(done.message.content).toEqual([
    { type: "thinking", text: "think " },
    { type: "text", text: "Hello" },
  ])
  expect(done.message.stopReason).toBe("end")
  expect(done.message.usage).toEqual({ input: 60, output: 5, cacheRead: 40, cacheWrite: 0 })
})

test("assembles streamed tool calls and keeps invalid JSON arguments", async () => {
  const ai = createAi({
    fetch: fakeFetch(
      sseResponse([
        delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"pa' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }),
        delta({ tool_calls: [{ index: 1, id: "c2", function: { name: "bash", arguments: "{oops" } }] }),
        delta({}, "tool_calls"),
      ]),
    ),
  })
  const msg = await collect(
    ai.stream({
      model: ai.model("ollama/qwen"),
      systemPrompt: "",
      messages: [],
      tools: [{ name: "read", description: "d", parameters: { type: "object" } }],
    }),
  )
  expect(msg.stopReason).toBe("toolUse")
  expect(msg.content).toEqual([
    { type: "toolCall", id: "c1", name: "read", args: { path: "a.ts" } },
    { type: "toolCall", id: "c2", name: "bash", args: { [INVALID_ARGS_KEY]: "{oops" } },
  ])
})

test("reports HTTP errors and marks 429 as retryable", async () => {
  const ai = createAi({
    env: { OPENAI_API_KEY: "k" },
    retry: { retries: 0 },
    fetch: fakeFetch(new Response("slow down", { status: 429 })),
  })
  const events: StreamEvent[] = []
  for await (const e of ai.stream({ model: ai.model("openai/x"), systemPrompt: "", messages: [], tools: [] }))
    events.push(e)
  expect(events).toHaveLength(1)
  const err = events[0] as Extract<StreamEvent, { type: "error" }>
  expect(err.type).toBe("error")
  expect(err.retryable).toBe(true)
  expect(err.error.status).toBe(429)
  expect(err.message.stopReason).toBe("error")
})

test("maps assistant tool calls and tool results to the chat format", () => {
  const out = toChatMessages("", [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      model: { provider: "p", model: "m" },
      content: [
        { type: "thinking", text: "hidden" },
        { type: "text", text: "ok" },
        { type: "toolCall", id: "c1", name: "read", args: { path: "a" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "data" }],
    },
  ])
  expect(out).toEqual([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "ok",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
    },
    { role: "tool", tool_call_id: "c1", content: "data" },
  ])
})

test("rejects malformed model references", () => {
  const ai = createAi()
  expect(() => ai.model("gpt")).toThrow(/provider\/model/)
  expect(() => ai.model("nope/x")).toThrow(/unknown provider/)
  expect(ai.model("openrouter/anthropic/claude").id).toBe("anthropic/claude")
})
