import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import type { ProviderCompat } from "../src/dialect.ts"
import { withBeta } from "../src/dialects/anthropic-compact.ts"
import type { Message, ModelRequest, Signature } from "../src/types.ts"

interface Call {
  url: string
  body: any
  headers: Record<string, string>
}

function setup(
  respond: (body: any) => Response,
  baseUrl = "https://api.anthropic.com",
  compat?: ProviderCompat,
  headers?: Record<string, string>,
) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    calls.push({ url, body, headers: init.headers as Record<string, string> })
    return respond(body)
  }) as unknown as typeof fetch
  const ai = createAi({
    fetch: fetchImpl,
    retry: { retries: 0 },
    providers: [
      {
        id: "anthropic",
        dialect: "anthropic-messages",
        baseUrl,
        ...(compat ? { compat } : {}),
        ...(headers ? { headers } : {}),
      },
    ],
  })
  const req = (): ModelRequest => ({
    model: ai.model("anthropic/claude-x"),
    systemPrompt: "sys",
    messages: [
      { role: "user", content: [{ type: "text", text: "build it" }] },
      {
        role: "assistant",
        model: { provider: "anthropic", model: "claude-x" },
        content: [{ type: "text", text: "done" }],
      },
    ],
    tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
  })
  return { ai, calls, req }
}

const block = { type: "compaction", content: "The user asked to build it; it is done.", signature: "SIG" }

const compacted = () =>
  Response.json({
    type: "message",
    role: "assistant",
    content: [block],
    stop_reason: "compaction",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [
        { type: "compaction", input_tokens: 4000, output_tokens: 250, cache_read_input_tokens: 100 },
        { type: "message", input_tokens: 0, output_tokens: 0 },
      ],
    },
  })

test("on by default only for api.anthropic.com, and only in the tail layout", () => {
  const official = setup(compacted)
  expect(official.ai.nativeCompaction(official.ai.model("anthropic/claude-x"))).toEqual({
    dialect: "anthropic-messages",
    methods: ["summarize"],
    layouts: ["tail"],
    midTurn: false,
  })
  const compatible = setup(compacted, "https://api.deepseek.com/anthropic")
  expect(compatible.ai.nativeCompaction(compatible.ai.model("anthropic/claude-x"))).toBeUndefined()
})

test("compaction on demand: the beta, the summarize field, and one readable signed block", async () => {
  const { ai, calls, req } = setup(compacted)
  const r = await ai.compact(req())
  expect(calls).toHaveLength(1)
  const call = calls[0]!
  expect(call.url).toBe("https://api.anthropic.com/v1/messages")
  expect(call.headers["anthropic-beta"]).toBe("compact-2026-09-04")
  expect(call.body).toMatchObject({ compaction: { type: "summarize" }, stream: false, model: "claude-x" })
  expect(call.body.system[0].text).toBe("sys")
  expect(call.body.tools.map((t: { name: string }) => t.name)).toEqual(["read", "web_search"])
  expect(call.body.tools[1]).toEqual({
    type: "web_search_20260318",
    name: "web_search",
    max_uses: 5,
    allowed_callers: ["direct"],
  })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.summary).toBe(block.content)
  expect(JSON.parse(r.checkpoint.value)).toEqual(block)
  expect(r.usage).toEqual({ input: 4000, output: 250, cacheRead: 100, cacheWrite: 0 })
})

test("a server that ignores the field and answers does not support it; an empty reply only failed", async () => {
  const answered = setup(
    () =>
      Response.json({ type: "message", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }),
    "http://localhost:8080",
    { compaction: "on" },
  )
  const r1 = await answered.ai.compact(answered.req())
  expect(!r1.ok && r1.tried[0]).toMatchObject({ unsupported: true })
  expect(answered.ai.nativeCompaction(answered.ai.model("anthropic/claude-x"))).toBeUndefined()

  const empty = setup(() => Response.json({ type: "message", content: [], stop_reason: "max_tokens" }))
  const r2 = await empty.ai.compact(empty.req())
  expect(!r2.ok && r2.tried[0]).toMatchObject({
    unsupported: false,
    error: expect.stringContaining("max_tokens"),
  })
  expect(empty.ai.nativeCompaction(empty.ai.model("anthropic/claude-x"))).toBeDefined()
})

test("errors about this compaction are not taken for a missing feature", async () => {
  const nothing = setup(() =>
    Response.json(
      { type: "error", error: { type: "compaction_nothing_to_summarize", message: "nothing to compact" } },
      { status: 400 },
    ),
  )
  const r = await nothing.ai.compact(nothing.req())
  expect(!r.ok && r.tried[0]?.unsupported).toBe(false)
  const unknown = setup(() =>
    Response.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message: "compaction: Extra inputs are not permitted" },
      },
      { status: 400 },
    ),
  )
  const r2 = await unknown.ai.compact(unknown.req())
  expect(!r2.ok && r2.tried[0]?.unsupported).toBe(true)
})

test("the checkpoint replays as the first assistant message with the beta, only to its own model", async () => {
  const sig: Signature = {
    dialect: "anthropic-messages",
    value: JSON.stringify(block),
    kind: "checkpoint",
    provider: "anthropic",
    host: "api.anthropic.com",
    model: "claude-x",
  }
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: `Summary:\n\n${block.content}`, signature: sig }] },
    {
      role: "assistant",
      model: { provider: "amira", model: "compaction" },
      content: [{ type: "text", text: "ACK", signature: sig }],
    },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ]
  const stream = () =>
    new Response(
      [
        `data: ${JSON.stringify({ type: "message_start", message: { usage: {} } })}`,
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} })}`,
        `data: ${JSON.stringify({ type: "message_stop" })}`,
        "",
      ].join("\n\n"),
      { headers: { "content-type": "text/event-stream" } },
    )
  const { ai, calls } = setup(stream, undefined, undefined, { "Anthropic-Beta": "other-beta" })
  const send = async (model: string) => {
    for await (const _ of ai.stream({ model: ai.model(model), systemPrompt: "", messages, tools: [] })) {
    }
    return calls.at(-1)!
  }
  const same = await send("anthropic/claude-x")
  expect(same.body.messages).toEqual([
    { role: "assistant", content: [block] },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ])
  expect(same.headers["anthropic-beta"]).toBe("other-beta,compact-2026-09-04")
  expect(same.headers["Anthropic-Beta"]).toBeUndefined()

  // Another model reads the readable summary as text; no block, no beta.
  const other = await send("anthropic/claude-y")
  expect(JSON.stringify(other.body.messages)).not.toContain('"type":"compaction"')
  expect(JSON.stringify(other.body.messages)).toContain(block.content)
  expect(other.headers["anthropic-beta"]).toBeUndefined()
  expect(other.headers["Anthropic-Beta"]).toBe("other-beta")
})

test("withBeta adds to an existing list once", () => {
  expect(withBeta({ "anthropic-beta": "a, b" }, "b")).toEqual({ "anthropic-beta": "a,b" })
  expect(withBeta({ x: "1" }, "c")).toEqual({ x: "1", "anthropic-beta": "c" })
})
