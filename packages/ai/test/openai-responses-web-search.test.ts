// Hosted web search on the Responses API. The stream fixture is a trimmed recording of a
// real reply (ids shortened, text cut), in the documented event shapes:
// https://platform.openai.com/docs/guides/tools-web-search
// https://platform.openai.com/docs/api-reference/responses-streaming/response/web_search_call
import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { openaiResponses, responsesBody } from "../src/dialects/openai-responses.ts"
import { toResponsesInput } from "../src/dialects/openai-responses-input.ts"
import { resolveModelInfo } from "../src/providers.ts"
import { withRetry } from "../src/retry.ts"
import {
  adaptServerTools,
  describeServerTool,
  hasNativeWebSearch,
  isOpenAIVendorUrl,
  messageCitations,
  serverToolText,
} from "../src/server-tools.ts"
import type { AssistantMessage, Message, ServerToolBlock, StreamEvent, TextBlock } from "../src/types.ts"
import { namedSSE, req, run, sse } from "./dialect-helpers.ts"
import { events, type Seen } from "./helpers.ts"

const TEXT = "Latest LTS is v24.21.0. ([nodejs.org](https://nodejs.org/en/download))"
const START = TEXT.indexOf("(")
const citation = {
  type: "url_citation",
  start_index: START,
  end_index: TEXT.length,
  title: "Node.js — Download Node.js®",
  url: "https://nodejs.org/en/download",
}
const searchItem = {
  id: "ws_1",
  type: "web_search_call",
  status: "completed",
  action: {
    type: "search",
    query: "node.js latest lts",
    queries: ["node.js latest lts"],
    sources: [{ type: "url", url: "https://nodejs.org/en/download" }],
  },
}
const openItem = {
  id: "ws_2",
  type: "web_search_call",
  status: "completed",
  action: { type: "open_page", url: "https://nodejs.org/en/download" },
}

function searchEvents(item: Record<string, unknown>, index: number) {
  const id = item.id
  return [
    {
      type: "response.output_item.added",
      output_index: index,
      item: { id, type: "web_search_call", status: "in_progress" },
    },
    { type: "response.web_search_call.in_progress", item_id: id, output_index: index },
    { type: "response.web_search_call.searching", item_id: id, output_index: index },
    { type: "response.web_search_call.completed", item_id: id, output_index: index },
    { type: "response.output_item.done", output_index: index, item },
  ]
}

const recorded = [
  { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
  { type: "response.in_progress", response: { id: "resp_1", status: "in_progress", output: [] } },
  ...searchEvents(searchItem, 0),
  // A kind of event this version does not know: it must not break the stream.
  { type: "response.web_search_call.ranking", item_id: "ws_1", output_index: 0 },
  ...searchEvents(openItem, 1),
  {
    type: "response.output_item.added",
    output_index: 2,
    item: { id: "msg_1", type: "message", status: "in_progress", role: "assistant", content: [] },
  },
  {
    type: "response.content_part.added",
    item_id: "msg_1",
    output_index: 2,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  },
  {
    type: "response.output_text.delta",
    item_id: "msg_1",
    output_index: 2,
    content_index: 0,
    delta: TEXT.slice(0, 10),
  },
  { type: "response.something_new", item_id: "msg_1" },
  {
    type: "response.output_text.delta",
    item_id: "msg_1",
    output_index: 2,
    content_index: 0,
    delta: TEXT.slice(10),
  },
  {
    type: "response.output_text.annotation.added",
    item_id: "msg_1",
    output_index: 2,
    content_index: 0,
    annotation_index: 0,
    annotation: citation,
  },
  {
    type: "response.output_item.done",
    output_index: 2,
    item: {
      id: "msg_1",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: TEXT, annotations: [citation] }],
    },
  },
  {
    type: "response.completed",
    response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
  },
]

const webModel = { webSearch: true }

test("the request offers web_search as a server tool beside the functions, never as a function", () => {
  const body = responsesBody(
    req(
      "openai-responses",
      { tools: [{ name: "read", description: "Reads.", parameters: { type: "object" } }] },
      webModel,
    ),
  )
  expect(body.tools).toEqual([
    { type: "function", name: "read", description: "Reads.", parameters: { type: "object" }, strict: false },
    { type: "web_search" },
  ])
  expect(body.include).toEqual(["web_search_call.action.sources"])
  expect(body.tool_choice).toBeUndefined()
  // Without the capability nothing changes.
  const plain = responsesBody(req("openai-responses", {}, {}))
  expect(plain.tools).toBeUndefined()
  expect(plain.include).toBeUndefined()
})

test("reasoning and web search ask for both includes; web_search is added once", () => {
  const body = responsesBody(req("openai-responses", { reasoning: { effort: "low" } }, webModel))
  expect(body.include).toEqual(["reasoning.encrypted_content", "web_search_call.action.sources"])
  expect((body.tools as { type: string }[]).filter((t) => t.type === "web_search")).toHaveLength(1)
})

test("web search events stream in order, the reply goes on after the search, citations are kept", async () => {
  const { evs, last } = await run(
    openaiResponses,
    req("openai-responses", {}, webModel),
    sse(namedSSE(recorded as { type: string }[])),
  )
  const kinds = evs.map((e) =>
    e.type === "serverTool" ? `serverTool:${e.block.id}:${e.block.status}` : e.type,
  )
  expect(kinds).toEqual([
    "start",
    "serverTool:ws_1:running",
    "serverTool:ws_1:done",
    "serverTool:ws_2:running",
    "serverTool:ws_2:done",
    "text.delta",
    "text.delta",
    "done",
  ])
  const final = evs.findLast((e) => e.type === "serverTool" && e.block.id === "ws_1") as Extract<
    StreamEvent,
    { type: "serverTool" }
  >
  expect(final.block.input).toEqual({
    type: "search",
    query: "node.js latest lts",
    queries: ["node.js latest lts"],
  })
  expect(final.block.sources).toEqual([{ url: "https://nodejs.org/en/download" }])

  if (last.type !== "done") throw new Error("expected done")
  const m = last.message
  expect(m.stopReason).toBe("end")
  expect(m.content.map((b) => b.type)).toEqual(["serverTool", "serverTool", "text"])
  expect(m.content.some((b) => b.type === "toolCall")).toBe(false)
  const text = m.content[2] as TextBlock
  expect(text.text).toBe(TEXT)
  expect(text.citations).toEqual([
    { url: citation.url, title: citation.title, start: START, end: TEXT.length },
  ])
  expect(TEXT.slice(text.citations![0]!.start, text.citations![0]!.end)).toContain("nodejs.org")
  const search = m.content[0] as ServerToolBlock
  expect(search.signature?.dialect).toBe("openai-responses")
  expect(JSON.parse(search.signature!.value)).toEqual(searchItem)
})

test("a completed search is not the end: without response.completed the stream fails", async () => {
  const cut = recorded.slice(0, 7)
  const { last } = await run(openaiResponses, req("openai-responses", {}, webModel), sse(namedSSE(cut)))
  expect(last.type).toBe("error")
})

test("citations arrive from the finished item when the server sends no annotation events", async () => {
  const noAnnotationEvents = recorded.filter((e) => e.type !== "response.output_text.annotation.added")
  const { last } = await run(
    openaiResponses,
    req("openai-responses", {}, webModel),
    sse(namedSSE(noAnnotationEvents as { type: string }[])),
  )
  if (last.type !== "done") throw new Error("expected done")
  const text = last.message.content.find((b) => b.type === "text") as TextBlock
  expect(text.citations?.[0]?.url).toBe(citation.url)
})

// --- History ---------------------------------------------------------------------------

const block = (host?: string): ServerToolBlock => ({
  type: "serverTool",
  id: "ws_1",
  name: "web_search",
  input: { type: "search", query: "node.js latest lts" },
  status: "done",
  sources: [{ url: "https://nodejs.org/en/download", title: "Download" }],
  signature: { dialect: "openai-responses", value: JSON.stringify(searchItem), ...(host ? { host } : {}) },
})

const history = (b: ServerToolBlock, provider = "openai"): Message[] => [
  { role: "user", content: [{ type: "text", text: "search" }] },
  {
    role: "assistant",
    model: { provider, model: "gpt" },
    content: [b, { type: "text", text: TEXT, citations: [{ url: citation.url }] }],
  },
  { role: "user", content: [{ type: "text", text: "and then?" }] },
]

test("a search goes back as its own item, never as a function call with an output", () => {
  const input = toResponsesInput(history(block("api.openai.com")))
  expect(input).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "search" }] },
    searchItem as never,
    { role: "assistant", content: TEXT },
    { type: "message", role: "user", content: [{ type: "input_text", text: "and then?" }] },
  ])
  expect(JSON.stringify(input)).not.toContain("function_call")
})

test("server tool items replay only to the same dialect, provider and host; elsewhere as a note", () => {
  const msgs = history(block("api.openai.com"))
  const same = { dialect: "openai-responses", provider: "openai", host: "api.openai.com", webSearch: true }
  expect(adaptServerTools(msgs, same)).toBe(msgs)
  for (const target of [
    { ...same, host: "localhost:8317" },
    { ...same, provider: "proxy" },
    { ...same, dialect: "anthropic-messages" },
    // The same endpoint, but the request no longer offers the hosted search.
    { ...same, webSearch: false },
  ]) {
    const out = adaptServerTools(msgs, target)
    const content = (out[1] as AssistantMessage).content
    expect(content[0]).toEqual({
      type: "text",
      text: '[Web search: "node.js latest lts"]\nSources:\n- Download: https://nodejs.org/en/download',
    })
    // The original history is left alone.
    expect((msgs[1] as AssistantMessage).content[0]!.type).toBe("serverTool")
  }
  // No host recorded: it cannot be told where it came from, so it goes as a note.
  const unstamped = adaptServerTools(history(block()), same)
  expect((unstamped[1] as AssistantMessage).content[0]!.type).toBe("text")
})

test("a search as a note joins the plain text around it in one assistant message", () => {
  const note = { ...block(), signature: undefined }
  const input = toResponsesInput(history(note))
  expect(input[1]).toEqual({
    role: "assistant",
    content: `[Web search: "node.js latest lts"]\nSources:\n- Download: https://nodejs.org/en/download\n\n${TEXT}`,
  })
  expect(input).toHaveLength(3)
})

test("a turn cut short around a search: reasoning before it stays, reasoning last is dropped", () => {
  const reasoning = {
    type: "thinking" as const,
    text: "",
    redacted: true,
    signature: { dialect: "openai-responses", value: JSON.stringify({ id: "rs_1", encrypted_content: "e" }) },
  }
  const turn = (content: AssistantMessage["content"]): Message[] => [
    { role: "user", content: [{ type: "text", text: "search" }] },
    { role: "assistant", model: { provider: "openai", model: "gpt" }, content },
  ]
  const types = (m: Message[]) => toResponsesInput(m).map((i) => ("type" in i ? i.type : "assistant"))
  expect(types(turn([reasoning, block("h")]))).toEqual(["message", "reasoning", "web_search_call"])
  expect(types(turn([block("h"), reasoning]))).toEqual(["message", "web_search_call"])
})

test("only a completed search is kept to replay; a failed or unfinished one goes as a note", async () => {
  const failed = { ...searchItem, status: "failed" }
  const cutShort = [
    ...searchEvents(failed, 0),
    // Status events for a search whose added item never came: it starts from them.
    { type: "response.web_search_call.in_progress", item_id: "ws_9", output_index: 1 },
    { type: "response.completed", response: { status: "completed" } },
  ]
  const { last } = await run(openaiResponses, req("openai-responses", {}, webModel), sse(namedSSE(cutShort)))
  if (last.type !== "done") throw new Error("expected done")
  const [a, b] = last.message.content as ServerToolBlock[]
  expect(a!.status).toBe("failed")
  expect(a!.signature).toBeUndefined()
  expect(b).toMatchObject({ id: "ws_9", status: "running" })
  expect(b!.signature).toBeUndefined()
  expect(serverToolText(b!)).toBe("[Web search (did not finish)]")
})

test("events without item ids are matched by output index", async () => {
  const anonymous = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "web_search_call", status: "in_progress" },
    },
    { type: "response.web_search_call.searching", output_index: 0 },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "web_search_call", status: "completed", action: { type: "search", query: "q" } },
    },
    { type: "response.completed", response: { status: "completed" } },
  ]
  const { last } = await run(openaiResponses, req("openai-responses", {}, webModel), sse(namedSSE(anonymous)))
  if (last.type !== "done") throw new Error("expected done")
  expect(last.message.content).toHaveLength(1)
  expect(last.message.content[0]).toMatchObject({ type: "serverTool", status: "done", input: { query: "q" } })
})

test("citations over several parts of a message count from the start of the block's text", async () => {
  const parts = [
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_1",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          { type: "output_text", text: "abc", annotations: [] },
          { type: "output_text", text: "def", annotations: [{ ...citation, start_index: 0, end_index: 3 }] },
        ],
      },
    },
    { type: "response.completed", response: { status: "completed" } },
  ]
  const { last } = await run(openaiResponses, req("openai-responses", {}, webModel), sse(namedSSE(parts)))
  if (last.type !== "done") throw new Error("expected done")
  const text = last.message.content[0] as TextBlock
  expect(text.text).toBe("abcdef")
  expect(text.citations?.[0]).toMatchObject({ start: 3, end: 6 })
})

test("the client stamps the host on server tool blocks and replays them to that host only", async () => {
  const seen: Seen[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen.push({ body: JSON.parse(init.body as string) })
    return sse(namedSSE(recorded as { type: string }[]))
  }) as unknown as typeof fetch
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
  const model = ai.model("openai/gpt-5")
  expect(hasNativeWebSearch(model)).toBe(true)
  const evs = await events(
    ai.stream({
      model,
      systemPrompt: "",
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
      tools: [],
    }),
  )
  const done = evs.at(-1)
  if (done?.type !== "done") throw new Error("expected done")
  const search = done.message.content[0] as ServerToolBlock
  expect(search.signature?.host).toBe("api.openai.com")
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    done.message,
    { role: "user", content: [{ type: "text", text: "more" }] },
  ]
  await events(ai.stream({ model, systemPrompt: "", messages, tools: [] }))
  expect(seen[1]!.body.input[1]).toEqual(searchItem)
  // The same history sent to another host: the search goes as text.
  await events(ai.stream({ model: ai.model("proxy/gpt-5"), systemPrompt: "", messages, tools: [] }))
  const moved = seen[2]!.body.input
  expect(moved.some((i: { type?: string }) => i.type === "web_search_call")).toBe(false)
  expect(moved[1]).toEqual({ role: "assistant", content: expect.stringContaining("[Web search:") })
})

// --- Settings ---------------------------------------------------------------------------

test("hosted web search is on by default only at the vendor's Responses endpoints", () => {
  const at = (baseUrl: string, dialect = "openai-responses", extra = {}) =>
    resolveModelInfo({ id: "p", dialect, baseUrl, ...extra }, "gpt-5").caps.webSearch
  expect(at("https://api.openai.com/v1")).toBe(true)
  expect(at("https://myres.openai.azure.com/openai/v1")).toBe(true)
  expect(at("http://localhost:8317/v1")).toBeUndefined()
  expect(at("https://openrouter.ai/api/v1")).toBeUndefined()
  expect(at("https://api.openai.com/v1", "openai-chat")).toBeUndefined()
  // The provider's compat turns it on or off; a model's caps win over both.
  expect(at("http://localhost:8317/v1", "openai-responses", { compat: { webSearch: true } })).toBe(true)
  expect(
    at("https://api.openai.com/v1", "openai-responses", { compat: { webSearch: false } }),
  ).toBeUndefined()
  expect(
    at("http://localhost:8317/v1", "openai-responses", {
      compat: { webSearch: true },
      models: [{ id: "gpt-5", caps: { webSearch: false } }],
    }),
  ).toBe(false)
  expect(isOpenAIVendorUrl("not a url")).toBe(false)
})

test("the user switch turns hosted web search off for every provider", () => {
  const providers = [{ id: "openai", dialect: "openai-responses", baseUrl: "https://api.openai.com/v1" }]
  expect(hasNativeWebSearch(createAi({ providers }).model("openai/gpt-5"))).toBe(true)
  expect(hasNativeWebSearch(createAi({ providers, webSearch: false }).model("openai/gpt-5"))).toBe(false)
})

test("only dialects with a hosted search, and models with native tools, have one", () => {
  const model = (dialect: string, tools: "native" | "none" = "native") =>
    req(dialect, {}, { webSearch: true, tools }).model
  expect(hasNativeWebSearch(model("openai-responses"))).toBe(true)
  expect(hasNativeWebSearch(model("openai-chat"))).toBe(false)
  expect(hasNativeWebSearch(model("openai-responses", "none"))).toBe(false)
})

test("descriptions and citations for frontends", () => {
  expect(describeServerTool({ name: "web_search", input: { type: "open_page", url: "https://a.b" } })).toBe(
    "Web search: opened https://a.b",
  )
  expect(
    describeServerTool({
      name: "web_search",
      input: { type: "find_in_page", url: "https://a.b", pattern: "v2" },
    }),
  ).toBe('Web search: looked for "v2" in https://a.b')
  expect(describeServerTool({ name: "web_search", input: {} })).toBe("Web search")
  expect(serverToolText({ ...block(), status: "failed", sources: [] })).toBe(
    '[Web search: "node.js latest lts" (failed)]',
  )
  expect(
    messageCitations([
      { type: "text", text: "a", citations: [{ url: "https://x" }, { url: "https://y", title: "Y" }] },
      { type: "text", text: "b", citations: [{ url: "https://x", title: "X" }] },
    ]),
  ).toEqual([
    { url: "https://x", title: "X" },
    { url: "https://y", title: "Y" },
  ])
})

test("a failure after a search was shown is not retried: it would search again", async () => {
  let opened = 0
  const attempt = async function* (): AsyncGenerator<StreamEvent> {
    opened++
    yield { type: "start" }
    yield { type: "serverTool", block: { ...block(), status: "running" } }
    yield {
      type: "error",
      error: { message: "overloaded", status: 503 },
      retryable: true,
      message: { role: "assistant", content: [], model: { provider: "p", model: "m" } },
    }
  }
  const evs = await events(withRetry(attempt, new AbortController().signal, { baseDelayMs: 1 }))
  expect(opened).toBe(1)
  expect(evs.at(-1)?.type).toBe("error")
})
