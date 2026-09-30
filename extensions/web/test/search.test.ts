import { expect, test } from "bun:test"
import type { WebSettings } from "@amira/api"
import {
  BACKENDS,
  type Backend,
  brave,
  exa,
  normalizeDomain,
  parseExaText,
  renderResults,
  SearchError,
  type SearchQuery,
  search,
  searxng,
  tavily,
} from "../src/search.ts"
import { headersOf, jsonResponse, mockFetch } from "./util.ts"

const q = (over: Partial<SearchQuery> = {}): SearchQuery => ({
  query: "bun release",
  maxResults: 5,
  allowedDomains: [],
  blockedDomains: [],
  ...over,
})

function backendCtx(f: typeof fetch, settings: WebSettings["search"] = {}, env: Record<string, string> = {}) {
  return { fetch: f, env, settings, signal: new AbortController().signal }
}

const EXA_TEXT = [
  "Title: Bun 1.4 | Bun Blog",
  "URL: https://bun.com/blog/bun-v1.4",
  "Published: 2026-08-20T00:00:00.000Z",
  "Author: N/A",
  "Highlights:",
  "Bun 1.4 adds things.",
  "",
  "---",
  "",
  "A rule inside the highlights.",
  "",
  "---",
  "",
  "Title: Bun v1.4",
  "URL: https://github.com/oven-sh/bun/releases/tag/bun-v1.4.0",
  "Published: N/A",
  "Author: N/A",
  "Highlights:",
  "# Bun v1.4",
].join("\n")

test("exa: calls web_search_exa over Streamable HTTP and parses the SSE answer", async () => {
  const sse = `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text: EXA_TEXT }] }, jsonrpc: "2.0", id: 1 })}\n\n`
  const m = mockFetch(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }))
  const found = await exa(q({ allowedDomains: ["bun.com"] }), backendCtx(m.fetch))
  expect(m.calls[0]?.url).toBe("https://mcp.exa.ai/mcp")
  const init = m.calls[0]?.init as RequestInit
  expect(init.method).toBe("POST")
  expect((init.headers as Record<string, string>).accept).toBe("application/json, text/event-stream")
  const body = JSON.parse(init.body as string)
  expect(body).toMatchObject({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "web_search_exa", arguments: { query: "bun release", numResults: 10 } },
  })
  expect(body.params.arguments.objective).toContain("Only results from bun.com.")
  expect(found).toEqual([
    {
      title: "Bun 1.4 | Bun Blog",
      url: "https://bun.com/blog/bun-v1.4",
      snippet: "Bun 1.4 adds things.\n\n---\n\nA rule inside the highlights.",
      date: "2026-08-20",
    },
    {
      title: "Bun v1.4",
      url: "https://github.com/oven-sh/bun/releases/tag/bun-v1.4.0",
      snippet: "# Bun v1.4",
    },
  ])
})

test("exa: plain JSON answers, JSON-RPC errors, tool errors, rate limits and the optional key", async () => {
  const ok = mockFetch(() =>
    jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: EXA_TEXT }] } }),
  )
  expect(
    await exa(q(), backendCtx(ok.fetch, { exa: { apiKeyEnv: "EXA_KEY" } }, { EXA_KEY: "k1" })),
  ).toHaveLength(2)
  expect((ok.calls[0]?.init.headers as Record<string, string> | undefined)?.["x-api-key"]).toBe("k1")
  expect(new URL(ok.calls[0]?.url as string).search).toBe("")
  await expect(exa(q(), backendCtx(ok.fetch, { exa: { apiKeyEnv: "EXA_KEY" } }))).rejects.toThrow(
    "EXA_KEY is not set",
  )

  const rpcError = mockFetch(() =>
    jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad args" } }),
  )
  await expect(exa(q(), backendCtx(rpcError.fetch))).rejects.toThrow("Exa: bad args")
  const toolError = mockFetch(() =>
    jsonResponse({
      jsonrpc: "2.0",
      id: 1,
      result: { isError: true, content: [{ type: "text", text: "boom" }] },
    }),
  )
  await expect(exa(q(), backendCtx(toolError.fetch))).rejects.toThrow("Exa: boom")
  const limited = mockFetch(() => new Response("slow down", { status: 429 }))
  await expect(exa(q(), backendCtx(limited.fetch))).rejects.toThrow("rate limit")
  const junk = mockFetch(() => new Response("<html>", { headers: { "content-type": "text/html" } }))
  await expect(exa(q(), backendCtx(junk.fetch))).rejects.toThrow("no JSON-RPC response")
})

test("parseExaText skips blocks without a URL", () => {
  expect(parseExaText("No results found.")).toEqual([])
})

test("brave: key header, site operators and result mapping", async () => {
  const m = mockFetch(() =>
    jsonResponse({
      web: {
        results: [
          {
            title: "<strong>Bun</strong> 1.4",
            url: "https://bun.com/blog",
            description: "fast &amp; new",
            page_age: "2026-08-20T10:00:00",
          },
          { title: "no url" },
        ],
      },
    }),
  )
  const found = await brave(
    q({ allowedDomains: ["bun.com", "github.com"], blockedDomains: ["x.com"] }),
    backendCtx(m.fetch, {}, { BRAVE_API_KEY: "secret" }),
  )
  const url = new URL(m.calls[0]?.url as string)
  expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search")
  expect(url.searchParams.get("q")).toBe("bun release (site:bun.com OR site:github.com) -site:x.com")
  expect(url.searchParams.get("count")).toBe("10")
  expect(headersOf(m.calls[0])["x-subscription-token"]).toBe("secret")
  expect(found).toEqual([
    { title: "Bun 1.4", url: "https://bun.com/blog", snippet: "fast & new", date: "2026-08-20T10:00:00" },
  ])
  await expect(brave(q(), backendCtx(m.fetch))).rejects.toThrow("BRAVE_API_KEY")
  await expect(
    brave(q(), backendCtx(m.fetch, { brave: { apiKeyEnv: "MY_BRAVE" } }, { BRAVE_API_KEY: "x" })),
  ).rejects.toThrow("MY_BRAVE")
})

test("tavily: bearer key, native domain filters and result mapping", async () => {
  const m = mockFetch(() =>
    jsonResponse({
      results: [
        { title: "T", url: "https://a.com/x", content: "c", score: 0.9, published_date: "2026-09-01" },
      ],
    }),
  )
  const found = await tavily(
    q({ allowedDomains: ["a.com"], blockedDomains: ["b.com"] }),
    backendCtx(m.fetch, { tavily: { searchDepth: "advanced" } }, { TAVILY_API_KEY: "tk" }),
  )
  expect(m.calls[0]?.url).toBe("https://api.tavily.com/search")
  expect(headersOf(m.calls[0]).authorization).toBe("Bearer tk")
  expect(JSON.parse(m.calls[0]?.init.body as string)).toEqual({
    query: "bun release",
    max_results: 5,
    search_depth: "advanced",
    include_domains: ["a.com"],
    exclude_domains: ["b.com"],
  })
  expect(found).toEqual([{ title: "T", url: "https://a.com/x", snippet: "c", date: "2026-09-01" }])
  const bad = mockFetch(() => new Response('{"detail":"Unauthorized"}', { status: 401 }))
  await expect(tavily(q(), backendCtx(bad.fetch, {}, { TAVILY_API_KEY: "tk" }))).rejects.toThrow(
    'Tavily answered HTTP 401: {"detail":"Unauthorized"}',
  )
})

test("searxng: JSON format request against the configured instance", async () => {
  const m = mockFetch(() =>
    jsonResponse({
      results: [{ title: "S", url: "https://s.org/", content: "snip", publishedDate: "2026-01-02" }],
    }),
  )
  const found = await searxng(
    q({ blockedDomains: ["x.com"] }),
    backendCtx(m.fetch, { searxng: { url: "http://localhost:8888/sx" } }),
  )
  const url = new URL(m.calls[0]?.url as string)
  expect(url.origin + url.pathname).toBe("http://localhost:8888/sx/search")
  expect(url.searchParams.get("format")).toBe("json")
  expect(url.searchParams.get("q")).toBe("bun release -site:x.com")
  expect(found).toEqual([{ title: "S", url: "https://s.org/", snippet: "snip", date: "2026-01-02" }])
  await expect(searxng(q(), backendCtx(m.fetch))).rejects.toThrow("web.search.searxng.url")
  const off = mockFetch(() => new Response("Forbidden", { status: 403 }))
  await expect(searxng(q(), backendCtx(off.fetch, { searxng: { url: "http://h" } }))).rejects.toThrow(
    "enable json under search.formats",
  )
})

const answer =
  (urls: string[]): Backend =>
  async () =>
    urls.map((url) => ({ title: url, url, snippet: "" }))
const failing =
  (msg: string): Backend =>
  async () => {
    throw new SearchError(msg)
  }

test("the fallback chain tries each backend in turn and reports what failed", async () => {
  const backends = {
    ...BACKENDS,
    exa: failing("Exa is down"),
    brave: failing("no key"),
    tavily: answer(["https://t.com/"]),
  }
  const settings = { fallback: ["brave", "tavily", "searxng"] as ("brave" | "tavily" | "searxng")[] }
  const out = await search(q(), { fetch, env: {}, settings }, new AbortController().signal, backends)
  expect(out).toEqual({
    backend: "tavily",
    results: [{ title: "https://t.com/", url: "https://t.com/", snippet: "" }],
    failures: ["exa: Exa is down", "brave: no key"],
  })
  expect(renderResults("q", out)).toContain("(Tried first: exa: Exa is down; brave: no key)")

  await expect(
    search(q(), { fetch, env: {}, settings: { backend: "brave" } }, new AbortController().signal, backends),
  ).rejects.toThrow("web search failed.\n- brave: no key")

  const thrower: Backend = async () => {
    throw new TypeError("fetch failed")
  }
  await expect(
    search(q(), { fetch, env: {}, settings: {} }, new AbortController().signal, {
      ...backends,
      exa: thrower,
    }),
  ).rejects.toThrow("- exa: request failed: fetch failed")
})

test("a backend that hangs times out and the next one answers; the caller's abort stops the chain", async () => {
  const hang: Backend = (_q, ctx) =>
    new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason)))
  const backends = { ...BACKENDS, exa: hang, brave: answer(["https://b.com/"]) }
  const out = await search(
    q(),
    { fetch, env: {}, settings: { timeoutMs: 20, fallback: ["brave"] } },
    new AbortController().signal,
    backends,
  )
  expect(out.backend).toBe("brave")
  expect(out.failures).toEqual(["exa: timed out after 20 ms"])

  const ac = new AbortController()
  const pending = search(q(), { fetch, env: {}, settings: { fallback: ["brave"] } }, ac.signal, backends)
  ac.abort(new Error("user stop"))
  await expect(pending).rejects.toThrow("user stop")
})

test("results are filtered by domain on our side and cut to maxResults", async () => {
  const backends = {
    ...BACKENDS,
    exa: answer([
      "https://docs.bun.com/a",
      "https://bun.com.evil.io/",
      "https://x.com/",
      "https://bun.com/b",
      "https://bun.com/c",
    ]),
  }
  const out = await search(
    q({
      maxResults: 2,
      allowedDomains: [normalizeDomain("https://www.Bun.com/path")].map((d) => d.replace(/^www\./, "")),
    }),
    { fetch, env: {}, settings: {} },
    new AbortController().signal,
    backends,
  )
  expect(out.results.map((r) => r.url)).toEqual(["https://docs.bun.com/a", "https://bun.com/b"])
  const blocked = await search(
    q({ blockedDomains: ["bun.com"] }),
    { fetch, env: {}, settings: {} },
    new AbortController().signal,
    backends,
  )
  expect(blocked.results.map((r) => r.url)).toEqual(["https://bun.com.evil.io/", "https://x.com/"])
})

test("normalizeDomain strips schemes, paths, ports and wildcards", () => {
  expect(
    ["https://Example.com/x?y", "*.example.com", "example.com:443", "example.com."].map(normalizeDomain),
  ).toEqual(["example.com", "example.com", "example.com", "example.com"])
})

test("renderResults numbers results with url, date and a clipped snippet", () => {
  const text = renderResults("bun", {
    backend: "exa",
    failures: [],
    results: [
      { title: "A\n title", url: "https://a.com/", snippet: "x".repeat(1300), date: "2026-08-20" },
      { title: "B", url: "https://b.com/", snippet: "" },
    ],
  })
  expect(text).toStartWith(
    'Search results for "bun" (via exa):\n\n1. A title\n   https://a.com/\n   Published: 2026-08-20\n   xxx',
  )
  expect(text).toContain("…\n\n2. B\n   https://b.com/")
  expect(renderResults("z", { backend: "exa", failures: [], results: [] })).toEndWith("No results.")
})
