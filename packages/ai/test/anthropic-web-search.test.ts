import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { collect } from "../src/dialect.ts"
import { anthropicMessages } from "../src/dialects/anthropic.ts"
import { type AnthropicBlock, toAnthropicMessages } from "../src/dialects/anthropic-messages.ts"
import { requestBody } from "../src/dialects/anthropic-request.ts"
import { forReplay, type ReplayTarget } from "../src/thinking.ts"
import type { AssistantMessage, ServerToolBlock, TextBlock } from "../src/types.ts"
import { anthropicResponse, blockDelta, blockStart, blockStop, messageStop } from "./anthropic-helpers.ts"
import { namedSSE, req, run, sse } from "./dialect-helpers.ts"

// Fake streams in the documented shapes, not recordings of a live request:
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
const call: AnthropicBlock = {
  type: "server_tool_use",
  id: "s1",
  name: "web_search",
  input: { query: "Bun release" },
}
const result = {
  type: "web_search_tool_result" as const,
  tool_use_id: "s1",
  content: [
    {
      type: "web_search_result",
      url: "https://bun.sh",
      title: "Bun",
      encrypted_content: "opaque-result",
      page_age: "today",
    },
  ],
}
const citation = {
  type: "web_search_result_location",
  url: "https://bun.sh",
  title: "Bun",
  encrypted_index: "opaque-index",
  cited_text: "Source text",
}
const done = [
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
  },
  messageStop,
]
export const anthropicSearchStream = [
  {
    type: "message_start",
    message: { usage: { input_tokens: 10, server_tool_use: { web_search_requests: 0 } } },
  },
  blockStart(0, { ...call, input: {} }),
  blockDelta(0, { type: "input_json_delta", partial_json: '{"query":' }),
  blockDelta(0, { type: "input_json_delta", partial_json: '"Bun release"}' }),
  blockStop(0),
  { type: "future_search_event", content: "ignored" },
  blockStart(1, result),
  blockStop(1),
  blockStart(2, { type: "text", text: "" }),
  blockDelta(2, { type: "text_delta", text: "Bun " }),
  blockDelta(2, { type: "citations_delta", citation }),
  blockDelta(2, { type: "text_delta", text: "is current." }),
  blockStop(2),
  ...done,
]
const searchReq = () => req("anthropic-messages", {}, { webSearch: true })

test("Messages offers the basic hosted tool alongside functions", () => {
  const r = searchReq()
  r.tools = [{ name: "read", description: "Read", parameters: { type: "object" } }]
  expect(requestBody(r).tools).toEqual([
    { name: "read", description: "Read", input_schema: { type: "object" } },
    { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  ])
  r.model.caps.webSearch = false
  expect((requestBody(r).tools as any[]).map((t) => t.name)).toEqual(["read"])
})

test("Messages streams searches as server rows, text citations and cumulative search usage", async () => {
  const { evs, last } = await run(anthropicMessages, searchReq(), sse(namedSSE(anthropicSearchStream)))
  expect(last.type).toBe("done")
  if (last.type !== "done") throw new Error("expected done")
  expect(last.message.stopReason).toBe("end")
  expect(last.message.content.map((b) => b.type)).toEqual(["serverTool", "text"])
  expect(evs.filter((e) => e.type === "serverTool").map((e) => e.block.status)).toEqual(["running", "done"])
  expect(evs.some((e) => e.type === "toolCall.delta")).toBe(false)
  expect(evs.filter((e) => e.type === "serverTool").every((e) => e.block.signature === undefined)).toBe(true)
  expect(last.message.usage?.webSearchRequests).toBe(1)
  const [search, text] = last.message.content as [ServerToolBlock, TextBlock]
  expect(search.input).toEqual(call.input)
  expect(search.sources).toEqual([{ url: "https://bun.sh", title: "Bun" }])
  expect(text.text).toBe("Bun is current.")
  expect(text.citations).toEqual([{ url: "https://bun.sh", title: "Bun" }])
  expect(toAnthropicMessages([last.message])[0]?.content).toEqual([
    call,
    result,
    { type: "text", text: "Bun is current.", citations: [citation] },
  ])
})

test("whole Messages replies retain initial citations, empty results and search errors", async () => {
  const failed = {
    ...result,
    tool_use_id: "s2",
    content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
  }
  const blocks: AnthropicBlock[] = [
    call,
    { ...result, content: [] },
    { ...call, id: "s2" },
    failed,
    { type: "text", text: "No more searches.", citations: [citation] },
  ]
  const { last } = await run(
    anthropicMessages,
    searchReq(),
    Response.json({
      type: "message",
      content: blocks,
      stop_reason: "end_turn",
      usage: { server_tool_use: { web_search_requests: 1 } },
    }),
  )
  if (last.type !== "done") throw new Error("expected done")
  expect(last.message.content.filter((b) => b.type === "serverTool").map((b) => b.status)).toEqual([
    "done",
    "failed",
  ])
  expect(last.message.content[1]).toMatchObject({ input: { error_code: "max_uses_exceeded" } })
  expect(toAnthropicMessages([last.message])[0]?.content).toEqual(blocks)
})

test("multiple interleaved searches replay in wire order", async () => {
  const second = { ...call, id: "s2", input: { query: "Node release" } }
  const secondResult = { ...result, tool_use_id: "s2" }
  const blocks: AnthropicBlock[] = [
    call,
    second,
    { type: "text", text: "Searching." },
    secondResult,
    result,
    { type: "text", text: "Done." },
  ]
  const { last } = await run(
    anthropicMessages,
    searchReq(),
    Response.json({ type: "message", content: blocks, stop_reason: "end_turn" }),
  )
  if (last.type !== "done") throw new Error("expected done")
  expect(toAnthropicMessages([last.message])[0]?.content).toEqual(blocks)
})

async function signedReply(): Promise<AssistantMessage> {
  const ai = createAi({
    env: {},
    retry: { retries: 0 },
    fetch: (async () => sse(namedSSE(anthropicSearchStream))) as unknown as typeof fetch,
    providers: [{ id: "anth", dialect: "anthropic-messages", baseUrl: "https://api.anthropic.com" }],
  })
  return collect(ai.stream({ model: ai.model("anth/claude"), systemPrompt: "", messages: [], tools: [] }))
}

test("encrypted search results and citation indices replay only to the same dialect, provider, host and offered tool", async () => {
  const message = await signedReply()
  const target: ReplayTarget = {
    dialect: "anthropic-messages",
    provider: "anth",
    host: "api.anthropic.com",
    model: "claude",
    webSearch: true,
  }
  expect(forReplay([message], target)[0]).toBe(message)
  for (const change of [
    { dialect: "google-gemini" },
    { provider: "other" },
    { host: "proxy.test" },
    { webSearch: false },
  ]) {
    const filtered = forReplay([message], { ...target, ...change })
    const body = JSON.stringify(toAnthropicMessages(filtered))
    expect(body).not.toContain("opaque-result")
    expect(body).not.toContain("opaque-index")
    expect(body).toContain("Web search")
    expect(body).toContain("https://bun.sh")
    expect(body).toContain("Bun is current.")
  }
  const withoutHost = structuredClone(message)
  for (const b of withoutHost.content) if (b.type !== "toolCall" && b.signature) delete b.signature.host
  expect(JSON.stringify(toAnthropicMessages(forReplay([withoutHost], target)))).not.toContain("opaque-")
  expect(JSON.stringify(message)).toContain("opaque-index")
})

test("compatible hosts can search without citations; incomplete input does not receive a replay signature", async () => {
  const blocks = [call, result, { type: "text", text: "Done." }]
  const { last } = await run(
    anthropicMessages,
    searchReq(),
    Response.json({ type: "message", content: blocks, stop_reason: "end_turn" }),
  )
  if (last.type !== "done") throw new Error("expected done")
  expect((last.message.content.at(-1) as TextBlock).citations).toBeUndefined()
  const partial = await run(anthropicMessages, searchReq(), sse(namedSSE(anthropicSearchStream.slice(0, 3))))
  expect(partial.last.type).toBe("error")
  if (partial.last.type !== "error") throw new Error("expected error")
  expect((partial.last.message.content[0] as ServerToolBlock).signature).toBeUndefined()
})

test("a paused server call can be replayed unchanged on the next request", async () => {
  const { last } = await run(
    anthropicMessages,
    searchReq(),
    anthropicResponse([
      blockStart(0, call),
      blockStop(0),
      { type: "message_delta", delta: { stop_reason: "pause_turn" } },
      messageStop,
    ]),
  )
  if (last.type !== "done") throw new Error("expected done")
  expect((last.message.content[0] as ServerToolBlock).status).toBe("running")
  expect(toAnthropicMessages([last.message])[0]?.content).toEqual([call])
})

test("search usage takes the latest reported counter rather than adding start and delta counts", async () => {
  const { last } = await run(
    anthropicMessages,
    searchReq(),
    anthropicResponse([
      { type: "message_start", message: { usage: { server_tool_use: { web_search_requests: 1 } } } },
      {
        type: "message_delta",
        usage: { server_tool_use: { web_search_requests: 2 } },
        delta: { stop_reason: "end_turn" },
      },
      messageStop,
    ]),
  )
  if (last.type !== "done") throw new Error("expected done")
  expect(last.message.usage?.webSearchRequests).toBe(2)
})
