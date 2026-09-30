import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import type { ProviderCompat } from "../src/dialect.ts"
import { isOfficialResponsesUrl } from "../src/dialects/openai-responses-compact.ts"
import { toResponsesInput } from "../src/dialects/openai-responses-input.ts"
import type { Message, ModelRequest, Signature } from "../src/types.ts"
import { sseResponse } from "./helpers.ts"

interface Call {
  url: string
  body: any
}

/** A fetch that answers by path from `routes`, recording each request. */
function router(routes: Record<string, (body: any) => Response>) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    calls.push({ url, body })
    const path = new URL(url).pathname
    const route = Object.entries(routes).find(([p]) => path.endsWith(p))
    return route ? route[1](body) : new Response("not found", { status: 404 })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const history: Message[] = [
  { role: "user", content: [{ type: "text", text: "build it" }] },
  {
    role: "assistant",
    model: { provider: "openai", model: "gpt-x" },
    content: [{ type: "text", text: "done" }],
  },
]

function setup(
  routes: Record<string, (body: any) => Response>,
  baseUrl = "https://api.openai.com/v1",
  compat?: ProviderCompat,
) {
  const { calls, fetchImpl } = router(routes)
  const ai = createAi({
    fetch: fetchImpl,
    retry: { retries: 0 },
    providers: [{ id: "openai", dialect: "openai-responses", baseUrl, ...(compat ? { compat } : {}) }],
  })
  const req = (): ModelRequest => ({
    model: ai.model("openai/gpt-x"),
    systemPrompt: "sys",
    messages: history,
    tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
  })
  return { ai, calls, req }
}

const compactionItem = { type: "compaction", id: "cmp_1", encrypted_content: "ENC" }
const usage = { input_tokens: 5000, output_tokens: 300, input_tokens_details: { cached_tokens: 1000 } }

const triggered = () =>
  sseResponse([
    { type: "response.output_item.added", output_index: 0, item: { type: "compaction", id: "cmp_1" } },
    { type: "response.compaction.compacting", item_id: "cmp_1", output_index: 0, sequence_number: 2 },
    { type: "response.output_item.done", output_index: 0, item: compactionItem },
    { type: "response.completed", response: { usage } },
  ])

const answered = () =>
  sseResponse([
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Sure, " },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "here you go" },
    { type: "response.completed", response: { usage } },
  ])

test("the vendor's hosts: api.openai.com and Azure OpenAI", () => {
  expect(isOfficialResponsesUrl("https://api.openai.com/v1")).toBe(true)
  expect(isOfficialResponsesUrl("https://my-res.openai.azure.com/openai/v1")).toBe(true)
  expect(isOfficialResponsesUrl("https://x.cognitiveservices.azure.com/openai/v1")).toBe(true)
  expect(isOfficialResponsesUrl("https://gateway.azure-api.net/openai")).toBe(true)
  expect(isOfficialResponsesUrl("http://localhost:8317/v1")).toBe(false)
  expect(isOfficialResponsesUrl("https://openrouter.ai/api/v1")).toBe(false)
  expect(isOfficialResponsesUrl("not a url")).toBe(false)
})

test("the trigger goes last on an ordinary streaming request, and its one item is the checkpoint", async () => {
  const { ai, calls, req } = setup({ "/responses": triggered })
  let progress = 0
  const r = await ai.compact(req(), undefined, () => progress++)
  expect(calls).toHaveLength(1)
  const body = calls[0]!.body
  expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses")
  expect(body.input.at(-1)).toEqual({ type: "compaction_trigger" })
  expect(body.input).toHaveLength(3)
  expect(body).toMatchObject({ stream: true, store: false, instructions: "sys", model: "gpt-x" })
  expect(body.tools.map((t: { name: string }) => t.name)).toEqual(["read"])
  expect(progress).toBe(1)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.method).toBe("trigger")
  expect(JSON.parse(r.checkpoint.value)).toEqual(compactionItem)
  expect(r.checkpoint).toMatchObject({ provider: "openai", host: "api.openai.com", model: "gpt-x" })
  expect(r.summary).toBeUndefined()
  expect(r.usage).toEqual({ input: 4000, output: 300, cacheRead: 1000, cacheWrite: 0 })
})

test("a server that ignores the trigger and answers falls through to /responses/compact", async () => {
  const { ai, calls, req } = setup(
    {
      "/responses/compact": () =>
        Response.json({
          id: "r",
          object: "response.compaction",
          output: [{ type: "message", role: "user", content: [] }, compactionItem],
          usage: { input_tokens: 800, output_tokens: 50 },
        }),
      "/responses": answered,
    },
    "http://localhost:8317/v1",
    { compaction: "on" },
  )
  const r = await ai.compact(req())
  expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/responses", "/v1/responses/compact"])
  const compactBody = calls[1]!.body
  expect(compactBody).toEqual({
    model: "gpt-x",
    instructions: "sys",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "build it" }] },
      { role: "assistant", content: "done" },
    ],
  })
  expect(r.ok && r.method).toBe("endpoint")
  expect(r.ok && r.tried).toEqual([
    {
      method: "trigger",
      error: "the server returned no compaction item for compaction_trigger",
      unsupported: true,
    },
  ])
  // The ignored trigger's answer still cost tokens.
  expect(r.usage.input + r.usage.cacheRead).toBe(5000 + 800)
  // Remembered: the next compaction goes straight to the endpoint.
  expect(ai.nativeCompaction(ai.model("openai/gpt-x"))?.methods).toEqual(["endpoint"])
})

test("a 404 or 501 from /responses/compact leaves nothing: the caller writes a text summary", async () => {
  for (const status of [404, 501]) {
    const { ai, req } = setup(
      {
        "/responses/compact": () => new Response("/responses/compact not supported", { status }),
        "/responses": () =>
          Response.json(
            { error: { message: "Invalid value: 'compaction_trigger'", type: "invalid_request_error" } },
            { status: 400 },
          ),
      },
      "http://localhost:8317/v1",
      { compaction: "on" },
    )
    const r = await ai.compact(req())
    expect(r.ok).toBe(false)
    expect(!r.ok && r.tried.map((t) => [t.method, t.unsupported])).toEqual([
      ["trigger", true],
      ["endpoint", true],
    ])
    expect(ai.nativeCompaction(ai.model("openai/gpt-x"))).toBeUndefined()
  }
})

test("more than one compaction item is a failure, but not a reason to stop trying next time", async () => {
  const { ai, req } = setup({
    "/responses/compact": () =>
      Response.json({ output: [compactionItem, { ...compactionItem, id: "cmp_2" }] }),
    "/responses": () =>
      sseResponse([
        { type: "response.output_item.done", output_index: 0, item: compactionItem },
        { type: "response.output_item.done", output_index: 1, item: { ...compactionItem, id: "cmp_2" } },
        { type: "response.completed", response: { usage } },
      ]),
  })
  const r = await ai.compact(req())
  expect(r.ok).toBe(false)
  expect(!r.ok && r.tried.every((t) => !t.unsupported && t.error.includes("exactly one"))).toBe(true)
  expect(ai.nativeCompaction(ai.model("openai/gpt-x"))?.methods).toEqual(["trigger", "endpoint"])
})

test("a checkpoint replays as its compaction item in place of the summary pair", () => {
  const sig: Signature = {
    dialect: "openai-responses",
    value: JSON.stringify(compactionItem),
    kind: "checkpoint",
    provider: "openai",
    host: "api.openai.com",
    model: "gpt-x",
  }
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "earlier ask" }] },
    { role: "user", content: [{ type: "text", text: "The earlier part…\n\n", signature: sig }] },
    {
      role: "assistant",
      model: { provider: "amira", model: "compaction" },
      content: [{ type: "text", text: "Understood.", signature: sig }],
    },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ]
  expect(toResponsesInput(messages)).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "earlier ask" }] },
    { type: "compaction", id: "cmp_1", encrypted_content: "ENC" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
  ])
})

test("the checkpoint goes to the same provider, host and model only; elsewhere its text does", async () => {
  const sig: Signature = {
    dialect: "openai-responses",
    value: JSON.stringify(compactionItem),
    kind: "checkpoint",
    provider: "openai",
    host: "api.openai.com",
    model: "gpt-x",
  }
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "SUMMARY TEXT", signature: sig }] },
    {
      role: "assistant",
      model: { provider: "amira", model: "compaction" },
      content: [{ type: "text", text: "ACK", signature: sig }],
    },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ]
  const { ai, calls } = setup({ "/responses": answered })
  const send = async (model: string) => {
    for await (const _ of ai.stream({ model: ai.model(model), systemPrompt: "", messages, tools: [] })) {
    }
    return JSON.stringify(calls.at(-1)!.body.input)
  }
  const same = await send("openai/gpt-x")
  expect(same).toContain('"encrypted_content":"ENC"')
  expect(same).not.toContain("SUMMARY TEXT")
  const other = await send("openai/gpt-y")
  expect(other).not.toContain("ENC")
  expect(other).toContain("SUMMARY TEXT")
  expect(other).toContain("ACK")
})

const searchItem = {
  id: "ws_1",
  type: "web_search_call",
  status: "completed",
  action: { type: "search", query: "node lts", sources: [{ type: "url", url: "https://nodejs.org" }] },
}

/** A turn with a hosted search from `provider` at `host`, its reply citing a source. */
const searched = (host: string, provider = "openai"): Message[] => [
  { role: "user", content: [{ type: "text", text: "search it" }] },
  {
    role: "assistant",
    model: { provider, model: "gpt-x" },
    content: [
      {
        type: "serverTool",
        id: "ws_1",
        name: "web_search",
        input: { type: "search", query: "node lts" },
        status: "done",
        sources: [{ url: "https://nodejs.org", title: "Node.js" }],
        signature: { dialect: "openai-responses", value: JSON.stringify(searchItem), host },
      },
      { type: "text", text: "v24 is LTS", citations: [{ url: "https://nodejs.org", title: "Node.js" }] },
    ],
  },
  { role: "user", content: [{ type: "text", text: "and now?" }] },
]

test("compacting a history with a hosted search: the item and the tool go along at its own endpoint", async () => {
  const { ai, calls, req } = setup({ "/responses": triggered }, "https://api.openai.com/v1", {
    webSearch: true,
  })
  const r = await ai.compact({ ...req(), messages: searched("api.openai.com") })
  expect(r.ok).toBe(true)
  const body = calls[0]!.body
  // The trigger request offers what a reply's request would: the functions and the hosted search.
  expect(body.tools.map((t: { type: string; name?: string }) => t.name ?? t.type)).toEqual([
    "read",
    "web_search",
  ])
  expect(body.input.map((i: { type?: string }) => i.type ?? "assistant")).toEqual([
    "message",
    "web_search_call",
    "assistant",
    "message",
    "compaction_trigger",
  ])
  expect(body.input[1]).toEqual(searchItem)
  // The cited text goes as it was; citations are Amira's, not the server's.
  expect(body.input[2]).toEqual({ role: "assistant", content: "v24 is LTS" })
})

test("compacting a history with a search from elsewhere, or without the search on: a note goes instead", async () => {
  for (const [host, compat] of [
    ["api.openai.com", { compaction: "on" as const, webSearch: false }],
    ["localhost:8317", { compaction: "on" as const, webSearch: true }],
  ] as const) {
    // The search was run by this provider at api.openai.com.
    const { ai, calls, req } = setup({ "/responses": triggered }, `http://${host}/v1`, compat)
    const r = await ai.compact({ ...req(), messages: searched("api.openai.com") })
    expect(r.ok).toBe(true)
    const body = calls[0]!.body
    const text = JSON.stringify(body.input)
    expect(text).not.toContain("web_search_call")
    expect(text).toContain('[Web search: \\"node lts\\"]')
    expect(text).toContain("https://nodejs.org")
    expect(body.input.at(-1)).toEqual({ type: "compaction_trigger" })
  }
})

test("after a search and a server compaction, both replay together only to the same endpoint and model", async () => {
  const cp: Signature = {
    dialect: "openai-responses",
    value: JSON.stringify(compactionItem),
    kind: "checkpoint",
    provider: "openai",
    host: "api.openai.com",
    model: "gpt-x",
  }
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "SUMMARY TEXT", signature: cp }] },
    {
      role: "assistant",
      model: { provider: "amira", model: "compaction" },
      content: [{ type: "text", text: "ACK", signature: cp }],
    },
    ...searched("api.openai.com"),
  ]
  const { calls, fetchImpl } = router({ "/responses": answered })
  const ai = createAi({
    fetch: fetchImpl,
    retry: { retries: 0 },
    providers: [
      { id: "openai", dialect: "openai-responses", baseUrl: "https://api.openai.com/v1" },
      {
        id: "proxy",
        dialect: "openai-responses",
        baseUrl: "http://localhost:8317/v1",
        compat: { webSearch: true },
      },
    ],
  })
  const send = async (model: string) => {
    for await (const _ of ai.stream({ model: ai.model(model), systemPrompt: "", messages, tools: [] })) {
    }
    return calls.at(-1)!.body.input as { type?: string }[]
  }
  const types = (input: { type?: string }[]) => input.map((i) => i.type ?? "assistant")
  expect(types(await send("openai/gpt-x"))).toEqual([
    "compaction",
    "message",
    "web_search_call",
    "assistant",
    "message",
  ])
  // Another model at the same endpoint: the search item still goes, the checkpoint does not.
  const other = await send("openai/gpt-y")
  expect(types(other)).toEqual(["message", "assistant", "message", "web_search_call", "assistant", "message"])
  expect(JSON.stringify(other)).toContain("SUMMARY TEXT")
  // Another host: neither goes; the search is a note and the checkpoint its summary.
  const elsewhere = await send("proxy/gpt-x")
  expect(types(elsewhere)).toEqual(["message", "assistant", "message", "assistant", "message"])
  const text = JSON.stringify(elsewhere)
  expect(text).not.toContain("ENC")
  expect(text).not.toContain("web_search_call")
  expect(text).toContain('[Web search: \\"node lts\\"]')
})
