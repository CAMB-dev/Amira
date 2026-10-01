import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { collect } from "../src/dialect.ts"
import { geminiBody, googleGemini, toGeminiContents } from "../src/dialects/google-gemini.ts"
import { forReplay, type ReplayTarget } from "../src/thinking.ts"
import type { ServerToolBlock, TextBlock } from "../src/types.ts"
import { dataSSE, req, run, sse } from "./dialect-helpers.ts"

// Fake GenerateContent chunks, using the official grounding and tool-circulation shapes:
// https://ai.google.dev/api/generate-content
// https://ai.google.dev/gemini-api/docs/generate-content/tool-combination
const call = {
  thoughtSignature: "opaque-call",
  toolCall: { id: "s1", toolType: "GOOGLE_SEARCH_WEB", args: { queries: ["Bun release"] } },
}
const result = {
  thoughtSignature: "opaque-result",
  toolResponse: {
    id: "s1",
    toolType: "GOOGLE_SEARCH_WEB",
    response: { search_suggestions: "<div>Suggestions</div>" },
  },
}
const metadata = {
  webSearchQueries: ["Bun release", "", "Bun release", "Node release"],
  groundingChunks: [{ web: { uri: "https://bun.sh", title: "Bun" } }],
  groundingSupports: [
    { segment: { partIndex: 2, startIndex: 0, endIndex: 4, text: "Bun " }, groundingChunkIndices: [0] },
  ],
  searchEntryPoint: { renderedContent: "<div>Search suggestions</div>", sdkBlob: "opaque-suggestions" },
}
const chunk = (parts: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { parts }, ...extra }],
})
const fixture = [
  chunk([call]),
  { futureEvent: "ignored" },
  chunk([result]),
  chunk([{ text: "Bun " }]),
  chunk([{ text: "is current." }], { groundingMetadata: metadata, finishReason: "STOP" }),
  { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
]
const searchReq = (id = "gemini-3-flash-preview") => {
  const r = req("google-gemini", {}, { webSearch: true })
  r.model.id = id
  return r
}

test("Gemini 3 offers Google Search and circulation alongside functions; older models only without functions", () => {
  const r = searchReq()
  r.tools = [{ name: "read", description: "Read", parameters: { type: "object" } }]
  const body = geminiBody(r)
  expect((body.tools as any[]).map((t) => Object.keys(t)[0])).toEqual([
    "functionDeclarations",
    "googleSearch",
  ])
  expect(body.toolConfig).toEqual({ includeServerSideToolInvocations: true })
  r.model.id = "gemini-2.5-pro"
  expect((geminiBody(r).tools as any[]).map((t) => Object.keys(t)[0])).toEqual(["functionDeclarations"])
  expect(geminiBody(r).toolConfig).toBeUndefined()
  r.tools = []
  expect(geminiBody(r).tools).toEqual([{ googleSearch: {} }])
  expect(geminiBody(r).toolConfig).toBeUndefined()
  r.model.caps.webSearch = false
  expect(geminiBody(r).tools).toBeUndefined()
})

test("Gemini streams server tool parts, citations, suggestions and unique query usage, not function calls", async () => {
  const { evs, last } = await run(googleGemini, searchReq(), sse(dataSSE(fixture)))
  if (last.type !== "done") throw new Error("expected done")
  expect(last.message.stopReason).toBe("end")
  expect(last.message.content.map((b) => b.type)).toEqual(["serverTool", "text"])
  expect(evs.some((e) => e.type === "toolCall.delta")).toBe(false)
  expect(evs.filter((e) => e.type === "serverTool").map((e) => e.block.status)).toEqual([
    "running",
    "done",
    "done",
  ])
  expect(evs.filter((e) => e.type === "serverTool").every((e) => e.block.signature === undefined)).toBe(true)
  const [search, text] = last.message.content as [ServerToolBlock, TextBlock]
  expect(search.input).toEqual({ queries: ["Bun release"] })
  expect(search.sources).toEqual([{ url: "https://bun.sh", title: "Bun" }])
  expect(search.searchEntryPoint).toEqual(metadata.searchEntryPoint)
  expect(text.citations).toEqual([{ url: "https://bun.sh", title: "Bun", start: 0, end: 4 }])
  expect(last.message.usage).toMatchObject({ input: 10, output: 5, webSearchRequests: 2 })
  expect(toGeminiContents([last.message])[0]?.parts).toEqual([call, result, { text: "Bun is current." }])
})

test("incremental grounding chunks, nonzero part indices and UTF-8 ranges are accumulated", async () => {
  const chunks = [
    chunk([{ text: "Preface", thoughtSignature: "signed-text" }]),
    chunk([{ text: "中文 " }]),
    chunk([], {
      groundingMetadata: {
        webSearchQueries: ["a"],
        groundingChunks: [{ web: { uri: "https://a.test" } }],
        groundingSupports: [
          { segment: { partIndex: 1, startIndex: 0, endIndex: 6 }, groundingChunkIndices: [0, 1] },
        ],
      },
    }),
    chunk([{ text: "answer" }], {
      groundingMetadata: {
        webSearchQueries: ["b"],
        groundingChunks: [{ web: { uri: "https://b.test" } }],
        groundingSupports: [
          { segment: { partIndex: 1, startIndex: 7, endIndex: 13 }, groundingChunkIndices: [1] },
          { segment: { partIndex: 99, startIndex: 0, endIndex: 3 }, groundingChunkIndices: [0] },
          { segment: { partIndex: 1, startIndex: -1, endIndex: 3 }, groundingChunkIndices: [0] },
        ],
      },
      finishReason: "STOP",
    }),
  ]
  const { last } = await run(googleGemini, searchReq(), sse(dataSSE(chunks)))
  if (last.type !== "done") throw new Error("expected done")
  const texts = last.message.content.filter((b) => b.type === "text")
  expect(texts[0]?.citations).toBeUndefined()
  expect(texts[1]?.citations).toEqual([
    { url: "https://a.test", start: 0, end: 6 },
    { url: "https://b.test", start: 0, end: 6 },
    { url: "https://b.test", start: 7, end: 13 },
  ])
  expect(last.message.usage?.webSearchRequests).toBe(2)
  const search = last.message.content.find((b) => b.type === "serverTool")!
  expect(search.signature).toBeUndefined()
  expect(search.sources).toHaveLength(2)
})

test("metadata before text keeps its pending citations; Gemini 2.x query counts are not billed as searches", async () => {
  const chunks = [
    chunk([], {
      groundingMetadata: {
        ...metadata,
        groundingSupports: [{ segment: { startIndex: 0, endIndex: 4 }, groundingChunkIndices: [0] }],
      },
    }),
    chunk([{ text: "Bun " }], { finishReason: "STOP" }),
  ]
  const { last } = await run(googleGemini, searchReq("gemini-2.5-pro"), sse(dataSSE(chunks)))
  if (last.type !== "done") throw new Error("expected done")
  expect(last.message.usage?.webSearchRequests).toBeUndefined()
  expect((last.message.content[1] as TextBlock).citations).toHaveLength(1)
  const raw = JSON.stringify(toGeminiContents([last.message]))
  expect(raw).toContain("Web search")
  expect(raw).not.toContain("groundingMetadata")
  expect(raw).not.toContain("opaque-suggestions")
})

test("distinct text Parts in one chunk keep their own byte ranges after merging into a text block", async () => {
  const chunks = [
    chunk([{ text: "中文 " }, { text: "Bun " }]),
    chunk([{ text: "release" }], {
      groundingMetadata: {
        webSearchQueries: ["Bun"],
        groundingChunks: [{ web: { uri: "https://bun.sh" } }],
        groundingSupports: [
          { segment: { partIndex: 0, startIndex: 0, endIndex: 6 }, groundingChunkIndices: [0] },
          { segment: { partIndex: 1, startIndex: 0, endIndex: 11 }, groundingChunkIndices: [0] },
        ],
      },
      finishReason: "STOP",
    }),
  ]
  const { last } = await run(googleGemini, searchReq(), sse(dataSSE(chunks)))
  if (last.type !== "done") throw new Error("expected done")
  expect((last.message.content[0] as TextBlock).citations).toEqual([
    { url: "https://bun.sh", start: 0, end: 6 },
    { url: "https://bun.sh", start: 7, end: 18 },
  ])
})

test("multiple searches keep the server parts and signatures in wire order", async () => {
  const second = { ...call, toolCall: { ...call.toolCall, id: "s2", args: { queries: ["Node"] } } }
  const secondResult = { ...result, toolResponse: { ...result.toolResponse, id: "s2" } }
  const parts = [call, { text: "Searching." }, second, secondResult, result, { text: "Done." }]
  const { last } = await run(googleGemini, searchReq(), Response.json(chunk(parts, { finishReason: "STOP" })))
  if (last.type !== "done") throw new Error("expected done")
  expect(toGeminiContents([last.message])[0]?.parts).toEqual(parts)
})

test("Gemini server parts replay only to their own dialect, provider, host and offered tool", async () => {
  const ai = createAi({
    env: {},
    retry: { retries: 0 },
    fetch: (async () => sse(dataSSE(fixture))) as unknown as typeof fetch,
    providers: [
      { id: "google", dialect: "google-gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
    ],
  })
  const message = await collect(
    ai.stream({
      model: ai.model("google/gemini-3-flash-preview"),
      systemPrompt: "",
      messages: [],
      tools: [],
    }),
  )
  const target: ReplayTarget = {
    dialect: "google-gemini",
    provider: "google",
    host: "generativelanguage.googleapis.com",
    model: "gemini-3-flash-preview",
    webSearch: true,
  }
  expect(toGeminiContents(forReplay([message], target))[0]?.parts.slice(0, 2)).toEqual([call, result])
  for (const change of [
    { dialect: "anthropic-messages" },
    { provider: "other" },
    { host: "proxy.test" },
    { webSearch: false },
  ]) {
    const body = JSON.stringify(toGeminiContents(forReplay([message], { ...target, ...change })))
    expect(body).toContain("Web search")
    expect(body).toContain("https://bun.sh")
    expect(body).not.toContain("opaque-call")
    expect(body).not.toContain("opaque-result")
  }
  const disabled = searchReq()
  disabled.model.caps.webSearch = false
  expect(JSON.stringify(geminiBody({ ...disabled, messages: [message] }))).not.toContain("opaque-call")
  const older = searchReq("gemini-2.5-pro")
  const body = geminiBody({ ...older, messages: [message] })
  expect(body.tools).toEqual([{ googleSearch: {} }])
  expect(JSON.stringify(body.contents)).toContain("Web search")
  expect(JSON.stringify(body.contents)).not.toContain("opaque-call")
})

test("unknown server tool parts are ignored and provider errors preserve incomplete searches as notes", async () => {
  const res = await run(
    googleGemini,
    searchReq(),
    sse(
      dataSSE([
        chunk([{ toolCall: { id: "x", toolType: "FUTURE_TOOL" } }, call]),
        { error: { code: 503, message: "Unavailable", status: "UNAVAILABLE" } },
      ]),
    ),
  )
  expect(res.last.type).toBe("error")
  if (res.last.type !== "error") throw new Error("expected error")
  expect(res.last.retryable).toBe(true)
  expect(res.last.message.content).toHaveLength(1)
  expect((res.last.message.content[0] as ServerToolBlock).signature).toBeUndefined()
  expect(JSON.stringify(toGeminiContents([res.last.message]))).not.toContain("opaque-call")
})
