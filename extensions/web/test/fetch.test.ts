import { expect, test } from "bun:test"
import {
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  ToolRegistry,
} from "../../../packages/core/src/index.ts"
import { PageCache, renderPage } from "../src/fetch.ts"
import { htmlToMarkdown } from "../src/html.ts"
import { createWebExtension, WEB_FETCH_TOOL, WEB_SEARCH_TOOL, webTools } from "../src/index.ts"
import { ctx, headersOf, jsonResponse, mockFetch, publicResolver, text } from "./util.ts"

const PAGE = `<!doctype html><html><head><title>Hello &amp; welcome</title><style>p{color:red}</style>
<script>alert(1)</script></head><body><nav><a href="/home">Home</a></nav>
<h1>Heading</h1><p>Some <b>bold</b> text with a <a href="/docs?a=1">relative link</a>,
an <a href="#top">anchor</a> and <a href="javascript:void(0)">a script link</a>.</p>
<img src="/logo.png" alt="Logo"><img src="data:image/png;base64,AAAA" alt="inline"><img src="/spacer.gif">
<pre><code>const x = 1</code></pre><ul><li>one</li><li>two</li></ul>
<form><input name="q"><button>Go</button></form></body></html>`

const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } })

function tools(handler: Parameters<typeof mockFetch>[0], settings = {}, resolve = publicResolver()) {
  const m = mockFetch(handler)
  const cache = new PageCache()
  const t = webTools({ fetch: settings }, { fetch: m.fetch, resolve, cache })
  return { ...t, calls: m.calls, cache }
}

test("HTML becomes Markdown without scripts, styles, navigation or form controls", () => {
  expect(htmlToMarkdown(PAGE, "https://example.com/dir/page")).toBe(
    [
      "# Heading",
      "",
      "Some **bold** text with a [relative link](https://example.com/docs?a=1), an anchor and a script link.",
      "",
      "![Logo](https://example.com/logo.png)",
      "",
      "```",
      "const x = 1",
      "```",
      "",
      "-   one",
      "-   two",
    ].join("\n"),
  )
})

test("web_fetch returns the page with its title and content type", async () => {
  const t = tools(() => html(PAGE))
  const r = await t.webFetch.execute({ url: "https://example.com/page#frag" }, ctx())
  expect(r.isError).toBeUndefined()
  expect(text(r)).toStartWith(
    "URL: https://example.com/page\nTitle: Hello & welcome\nContent-Type: text/html; charset=utf-8\n\n# Heading",
  )
  expect(t.calls[0]?.url).toBe("https://example.com/page")
  expect(headersOf(t.calls[0])["user-agent"]).toContain("Amira")
})

test("requests go to the address that was checked, with the name in Host and TLS", async () => {
  const resolve = publicResolver({ "v6.test": ["2606:4700::1111"], "dual.test": ["2606:4700::1", "1.1.1.1"] })
  const t = tools(() => html("<p>ok</p>"), {}, resolve)
  await t.webFetch.execute({ url: "https://example.com:8443/page?q=1" }, ctx())
  await t.webFetch.execute({ url: "http://v6.test/" }, ctx())
  await t.webFetch.execute({ url: "http://dual.test/" }, ctx())
  expect(t.calls.map((c) => [c.wire, headersOf(c).host])).toEqual([
    ["https://93.184.215.14:8443/page?q=1", "example.com:8443"],
    ["http://[2606:4700::1111]/", "v6.test"],
    ["http://1.1.1.1/", "dual.test"],
  ])
  expect((t.calls[0]?.init as { tls?: unknown } | undefined)?.tls).toEqual({ serverName: "example.com" })
  expect((t.calls[1]?.init as { tls?: unknown } | undefined)?.tls).toBeUndefined()

  const direct = tools(() => html("<p>ok</p>"), { allowPrivateNetwork: true })
  await direct.webFetch.execute({ url: "https://example.com/" }, ctx())
  expect([direct.calls[0]?.wire, headersOf(direct.calls[0]).host]).toEqual([
    "https://example.com/",
    undefined,
  ])
})

test("the charset comes from the header, else from the page's BOM or meta tag", async () => {
  const latin1 = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)))
  const t = tools((url) => {
    const body = url.endsWith("/meta")
      ? latin1('<html><head><meta charset="iso-8859-1"></head><body><p>caf\xe9</p></body></html>')
      : latin1(
          '<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"></head><body><p>\x93q\x94</p></body></html>',
        )
    return new Response(body, { headers: { "content-type": "text/html" } })
  })
  expect(text(await t.webFetch.execute({ url: "https://x.test/meta" }, ctx()))).toEndWith("café")
  expect(text(await t.webFetch.execute({ url: "https://x.test/equiv" }, ctx()))).toEndWith("“q”")
})

test("a binary content type is refused without reading the body", async () => {
  let pulled = 0
  const body = new ReadableStream({
    pull(c) {
      pulled++
      c.enqueue(new Uint8Array(1024))
    },
  })
  const t = tools(() => new Response(body, { headers: { "content-type": "application/pdf" } }))
  expect(text(await t.webFetch.execute({ url: "https://x.test/a.pdf" }, ctx()))).toContain("is a PDF")
  expect(pulled).toBeLessThan(3)
})

test("an abort during the name lookup ends the call at once", async () => {
  const ac = new AbortController()
  const never = () => new Promise<string[]>(() => {})
  const t = tools(() => html(""), {}, never)
  const pending = t.webFetch.execute({ url: "https://slow-dns.test/" }, ctx(ac.signal))
  ac.abort(new Error("stopped"))
  await expect(pending).rejects.toThrow("stopped")
  const timed = tools(() => html(""), { timeoutMs: 20 }, never)
  expect(text(await timed.webFetch.execute({ url: "https://slow-dns.test/" }, ctx()))).toBe(
    "timed out after 20 ms fetching https://slow-dns.test/",
  )
})

test("redirects are followed, reported, and each hop is checked", async () => {
  const t = tools((url) => {
    if (url === "http://a.test/")
      return new Response(null, { status: 301, headers: { location: "https://b.test/x" } })
    if (url === "https://b.test/x")
      return new Response(null, { status: 302, headers: { location: "/final" } })
    return html("<p>done</p>")
  })
  const r = await t.webFetch.execute({ url: "http://a.test/" }, ctx())
  expect(text(r)).toContain("URL: http://a.test/\nRedirected to: https://b.test/final")
  expect(t.calls.map((c) => c.url)).toEqual(["http://a.test/", "https://b.test/x", "https://b.test/final"])
  expect(t.calls.every((c) => c.init.redirect === "manual")).toBe(true)

  const toPrivate = tools(
    () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
  )
  const blocked = await toPrivate.webFetch.execute({ url: "https://public.test/" }, ctx())
  expect(blocked.isError).toBe(true)
  expect(text(blocked)).toStartWith("refusing to fetch 169.254.169.254")
  expect(toPrivate.calls).toHaveLength(1)

  const toFile = tools(() => new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } }))
  expect(text(await toFile.webFetch.execute({ url: "https://public.test/" }, ctx()))).toContain(
    "redirected to an unusable URL: only http and https",
  )

  const loop = tools((url) => new Response(null, { status: 302, headers: { location: `${url}x` } }))
  expect(text(await loop.webFetch.execute({ url: "https://l.test/" }, ctx()))).toContain("too many redirects")
})

test("private addresses are refused unless allowed", async () => {
  const t = tools(() => html("<p>internal</p>"), {}, publicResolver({ "intranet.test": ["192.168.0.10"] }))
  for (const url of [
    "http://localhost:8080/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://intranet.test/",
  ]) {
    const r = await t.webFetch.execute({ url }, ctx())
    expect([url, r.isError]).toEqual([url, true])
    expect(text(r)).toMatch(/^refusing to fetch .*web.fetch.allowPrivateNetwork/)
  }
  expect(t.calls).toHaveLength(0)
  const allowed = tools(() => html("<p>internal</p>"), { allowPrivateNetwork: true })
  expect(text(await allowed.webFetch.execute({ url: "http://localhost:8080/" }, ctx()))).toContain("internal")
})

test("bad URLs, HTTP errors, PDFs and binary bodies are clear tool errors", async () => {
  const t = tools((url) => {
    if (url.endsWith("/404")) return html("<h1>Not Found</h1>", 404)
    if (url.endsWith(".pdf"))
      return new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } })
    if (url.endsWith("/sniff")) return new Response("%PDF-1.4 ...")
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })
  })
  const run = async (url: string) => {
    const r = await t.webFetch.execute({ url }, ctx())
    expect(r.isError).toBe(true)
    return text(r)
  }
  expect(await run("not a url")).toBe("not a valid URL: not a url")
  expect(await run("ftp://x.test/")).toContain("only http and https")
  expect(await run("https://user:pw@x.test/")).toContain("credentials")
  expect(await run("https://x.test/404")).toBe("HTTP 404 from https://x.test/404: <h1>Not Found</h1>")
  expect(await run("https://x.test/a.pdf")).toContain("is a PDF")
  expect(await run("https://x.test/sniff")).toContain("is a PDF")
  expect(await run("https://x.test/img")).toContain("is image/png")
})

test("JSON is pretty-printed and plain text is returned as is, decoded by charset", async () => {
  const t = tools((url) => {
    if (url.endsWith("/json")) return jsonResponse({ a: [1, 2] })
    return new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
      headers: { "content-type": "text/plain; charset=iso-8859-1" },
    })
  })
  expect(text(await t.webFetch.execute({ url: "https://x.test/json" }, ctx()))).toEndWith(
    '{\n  "a": [\n    1,\n    2\n  ]\n}',
  )
  expect(text(await t.webFetch.execute({ url: "https://x.test/latin" }, ctx()))).toEndWith("\n\ncafé")
})

test("long pages are cut with a marker and read on by offset from the cache", async () => {
  const para = (i: number) =>
    `<p>Paragraph ${i} ${"lorem ipsum ".repeat(8)}${i === 7 ? "pricing table" : ""}</p>`
  const t = tools(() => html(Array.from({ length: 10 }, (_, i) => para(i)).join("")), { maxChars: 250 })
  const first = text(await t.webFetch.execute({ url: "https://x.test/long", prompt: "Pricing" }, ctx()))
  const total = Number(/of (\d+)\./.exec(first)?.[1])
  expect(first).toContain(`Showing characters 0-250 of ${total}.`)
  expect(first).toContain(
    `[Truncated: ${total - 250} more characters. Call web_fetch with offset: 250 to read on.]`,
  )
  expect(first).toMatch(/Passages elsewhere mentioning your prompt:\n- offset \d+: Paragraph 7/)
  const second = text(
    await t.webFetch.execute({ url: "https://x.test/long", offset: 250, maxChars: 100_000 }, ctx()),
  )
  expect(second).toContain(`Showing characters 250-${total} of ${total}.`)
  expect(second).not.toContain("Truncated")
  expect(t.calls).toHaveLength(1)
  const past = text(await t.webFetch.execute({ url: "https://x.test/long", offset: total + 50 }, ctx()))
  expect(past).toContain("(no text at this offset)")
})

test("bodies over maxBytes are cut and say so", async () => {
  const t = tools(() => new Response("a".repeat(5000), { headers: { "content-type": "text/plain" } }), {
    maxBytes: 1000,
  })
  const r = text(await t.webFetch.execute({ url: "https://x.test/big" }, ctx()))
  expect(r).toContain("larger than the download limit")
  expect(r).toEndWith(`\n\n${"a".repeat(1000)}`)
})

test("the cache expires after its time to live", () => {
  let now = 0
  const cache = new PageCache(15 * 60_000, 2, () => now)
  const page = { url: "u", finalUrl: "u", status: 200, contentType: "", text: "t", bodyTruncated: false }
  cache.set("a", page)
  now = 15 * 60_000
  expect(cache.get("a")).toBe(page)
  now += 1
  expect(cache.get("a")).toBeUndefined()
  cache.set("a", page)
  cache.set("b", page)
  cache.set("c", page)
  expect([cache.get("a"), cache.get("b"), cache.get("c")]).toEqual([undefined, page, page])
})

test("the cache keeps a character budget, dropping the oldest pages", () => {
  const cache = new PageCache(60_000, 50, Date.now, 10)
  const page = (text: string) => ({
    url: "u",
    finalUrl: "u",
    status: 200,
    contentType: "",
    text,
    bodyTruncated: false,
  })
  cache.set("a", page("aaaa"))
  cache.set("b", page("bbbb"))
  cache.set("c", page("cccc"))
  expect([cache.get("a"), cache.get("b")?.text, cache.get("c")?.text]).toEqual([undefined, "bbbb", "cccc"])
  cache.set("big", page("x".repeat(11)))
  expect([cache.get("big"), cache.get("b")?.text]).toEqual([undefined, "bbbb"])
})

test("timeouts and aborts", async () => {
  const hang = (_url: string, init: RequestInit) =>
    new Promise<Response>((_, reject) =>
      init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
    )
  const slow = tools(hang, { timeoutMs: 20 })
  const r = await slow.webFetch.execute({ url: "https://x.test/" }, ctx())
  expect(text(r)).toBe("timed out after 20 ms fetching https://x.test/")

  const ac = new AbortController()
  const t = tools(hang)
  const pending = t.webFetch.execute({ url: "https://x.test/" }, ctx(ac.signal))
  ac.abort(new Error("stopped"))
  await expect(pending).rejects.toThrow("stopped")
})

test("renderPage without cuts has no marker", () => {
  const page = {
    url: "u",
    finalUrl: "u",
    status: 200,
    contentType: "text/plain",
    text: "hello",
    bodyTruncated: false,
  }
  expect(renderPage(page, 0, 100)).toBe("URL: u\nContent-Type: text/plain\n\nhello")
})

test("the extension registers both tools as parallel; tools.disabled hides them", async () => {
  const bus = new EventBus()
  const registry = new ToolRegistry()
  const host = new ExtensionHost({
    bus,
    interceptors: new InterceptorRegistry(),
    tools: registry,
    settings: {},
  })
  expect(await host.load(createWebExtension(), "builtin:web")).toBe(true)
  expect([registry.get(WEB_SEARCH_TOOL)?.concurrency, registry.get(WEB_FETCH_TOOL)?.concurrency]).toEqual([
    "parallel",
    "parallel",
  ])
  expect(registry.active().map((t) => t.name)).toEqual([WEB_SEARCH_TOOL, WEB_FETCH_TOOL])
  registry.setDisabled([WEB_SEARCH_TOOL])
  expect(registry.active().map((t) => t.name)).toEqual([WEB_FETCH_TOOL])
})

test("web_search renders results and turns failures into tool errors", async () => {
  const sse = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: A\nURL: https://a.com/\nPublished: N/A\nHighlights:\nabout a" }] } })}\n\n`
  const m = mockFetch(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }))
  const { webSearch } = webTools({}, { fetch: m.fetch, env: {} })
  const r = await webSearch.execute({ query: "  a  ", maxResults: 50 }, ctx())
  expect(text(r)).toBe('Search results for "a" (via exa):\n\n1. A\n   https://a.com/\n   about a')
  expect(JSON.parse(m.calls[0]?.init.body as string).params.arguments.numResults).toBe(20)
  expect((await webSearch.execute({ query: " " }, ctx())).isError).toBe(true)

  const down = mockFetch(() => new Response("oops", { status: 500 }))
  const failing = webTools({ search: { fallback: ["brave"] } }, { fetch: down.fetch, env: {} }).webSearch
  const e = await failing.execute({ query: "a" }, ctx())
  expect(e.isError).toBe(true)
  expect(text(e)).toBe(
    "web search failed.\n- exa: Exa answered HTTP 500: oops\n- brave: Brave needs an API key in the environment variable BRAVE_API_KEY",
  )
})
