import type { WebSearchBackend, WebSettings } from "@amira/api"

export interface SearchResult {
  title: string
  url: string
  snippet: string
  /** Publication date as the backend gave it. */
  date?: string
}

export interface SearchQuery {
  query: string
  maxResults: number
  allowedDomains: string[]
  blockedDomains: string[]
}

export interface BackendContext {
  signal: AbortSignal
  fetch: typeof fetch
  env: Record<string, string | undefined>
  settings: NonNullable<WebSettings["search"]>
}

export type Backend = (q: SearchQuery, ctx: BackendContext) => Promise<SearchResult[]>

/** A backend failure: the message is shown to the model, so it must not contain a key. */
export class SearchError extends Error {}

export const EXA_URL = "https://mcp.exa.ai/mcp"
export const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
export const TAVILY_URL = "https://api.tavily.com/search"

/** "https://www.Example.com/x" and "*.example.com" become "example.com"-style host suffixes. */
export function normalizeDomain(d: string): string {
  return d
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^\*\./, "")
    .replace(/[/?#:].*$/, "")
    .replace(/\.$/, "")
}

export function hostMatches(url: string, domains: string[]): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`))
}

/** Applies the domain filters on our side too, whatever the backend did with them. */
export function filterResults(results: SearchResult[], q: SearchQuery): SearchResult[] {
  return results
    .filter((r) => !q.allowedDomains.length || hostMatches(r.url, q.allowedDomains))
    .filter((r) => !hostMatches(r.url, q.blockedDomains))
    .slice(0, q.maxResults)
}

/** site: operators for backends that only take a query string. */
function siteOperators(q: SearchQuery): string {
  const allow = q.allowedDomains.map((d) => `site:${d}`)
  const parts = [q.query]
  if (allow.length === 1) parts.push(allow[0] as string)
  else if (allow.length > 1) parts.push(`(${allow.join(" OR ")})`)
  for (const d of q.blockedDomains) parts.push(`-site:${d}`)
  return parts.join(" ")
}

/** Asks for extra results when we will filter some out ourselves. */
const overfetch = (q: SearchQuery) =>
  q.allowedDomains.length || q.blockedDomains.length ? Math.min(q.maxResults * 2, 20) : q.maxResults

function apiKey(ctx: BackendContext, name: string, envName: string): string {
  const key = ctx.env[envName]
  if (!key) throw new SearchError(`${name} needs an API key in the environment variable ${envName}`)
  return key
}

async function httpError(name: string, res: Response): Promise<SearchError> {
  const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300)
  return new SearchError(`${name} answered HTTP ${res.status}${body ? `: ${body}` : ""}`)
}

async function json(name: string, res: Response): Promise<unknown> {
  if (!res.ok) throw await httpError(name, res)
  try {
    return await res.json()
  } catch {
    throw new SearchError(`${name} sent a response that is not JSON`)
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "")

function results(list: unknown, map: (r: Record<string, unknown>) => SearchResult): SearchResult[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map(map)
    .filter((r) => r.url)
}

const stripTags = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

/** Brave Search API: https://api-dashboard.search.brave.com/app/documentation/web-search */
export const brave: Backend = async (q, ctx) => {
  const key = apiKey(ctx, "Brave", ctx.settings.brave?.apiKeyEnv ?? "BRAVE_API_KEY")
  const url = new URL(BRAVE_URL)
  url.searchParams.set("q", siteOperators(q))
  url.searchParams.set("count", String(Math.min(overfetch(q), 20)))
  const res = await ctx.fetch(url, {
    headers: { accept: "application/json", "x-subscription-token": key },
    signal: ctx.signal,
  })
  const body = (await json("Brave", res)) as { web?: { results?: unknown } }
  return results(body.web?.results, (r) => ({
    title: stripTags(str(r.title)),
    url: str(r.url),
    snippet: stripTags(str(r.description)),
    ...(str(r.page_age) || str(r.age) ? { date: str(r.page_age) || str(r.age) } : {}),
  }))
}

/** Tavily: https://docs.tavily.com/documentation/api-reference/endpoint/search */
export const tavily: Backend = async (q, ctx) => {
  const key = apiKey(ctx, "Tavily", ctx.settings.tavily?.apiKeyEnv ?? "TAVILY_API_KEY")
  const res = await ctx.fetch(TAVILY_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query: q.query,
      max_results: Math.min(q.maxResults, 20),
      search_depth: ctx.settings.tavily?.searchDepth ?? "basic",
      ...(q.allowedDomains.length ? { include_domains: q.allowedDomains } : {}),
      ...(q.blockedDomains.length ? { exclude_domains: q.blockedDomains } : {}),
    }),
    signal: ctx.signal,
  })
  const body = (await json("Tavily", res)) as { results?: unknown }
  return results(body.results, (r) => ({
    title: str(r.title),
    url: str(r.url),
    snippet: str(r.content),
    ...(str(r.published_date) ? { date: str(r.published_date) } : {}),
  }))
}

/** SearXNG's JSON API (search.formats must include json): https://docs.searxng.org/dev/search_api.html */
export const searxng: Backend = async (q, ctx) => {
  const base = ctx.settings.searxng?.url
  if (!base) throw new SearchError("SearXNG needs web.search.searxng.url in your user settings")
  let url: URL
  try {
    url = new URL("search", base.endsWith("/") ? base : `${base}/`)
  } catch {
    throw new SearchError(`web.search.searxng.url is not a valid URL: ${base}`)
  }
  url.searchParams.set("q", siteOperators(q))
  url.searchParams.set("format", "json")
  const res = await ctx.fetch(url, { headers: { accept: "application/json" }, signal: ctx.signal })
  if (res.status === 403)
    throw new SearchError("SearXNG refused the JSON format (HTTP 403); enable json under search.formats")
  const body = (await json("SearXNG", res)) as { results?: unknown }
  return results(body.results, (r) => ({
    title: str(r.title),
    url: str(r.url),
    snippet: str(r.content),
    ...(str(r.publishedDate) ? { date: str(r.publishedDate) } : {}),
  }))
}

/** Reads a JSON-RPC response from a Streamable HTTP MCP server: plain JSON or an SSE stream. */
async function mcpResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  const type = res.headers.get("content-type") ?? ""
  const candidates: string[] = []
  if (type.includes("text/event-stream")) {
    // Each event's data lines, joined; the response is the event carrying our id.
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n")
      if (data) candidates.push(data)
    }
  } else candidates.push(text)
  for (const c of candidates) {
    try {
      const msg = JSON.parse(c) as Record<string, unknown>
      if (msg && typeof msg === "object" && ("result" in msg || "error" in msg)) return msg
    } catch {}
  }
  throw new SearchError("Exa sent no JSON-RPC response")
}

/** Parses Exa's text blocks: "Title: …\nURL: …\nPublished: …\nAuthor: …\nHighlights:\n…", split by "---". */
export function parseExaText(text: string): SearchResult[] {
  const out: SearchResult[] = []
  // A "---" line inside a page's highlights is not a separator: blocks start with "Title:".
  for (const block of text.split(/\n+-{3,}\n+(?=Title:)/)) {
    const field = (name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(block)?.[1]?.trim() ?? ""
    const url = field("URL")
    if (!url) continue
    const body = /^(?:Highlights|Text|Summary):[ \t]*\n?([\s\S]*)$/m.exec(block)?.[1] ?? ""
    const date = field("Published")
    out.push({
      title: field("Title") || url,
      url,
      snippet: body.trim(),
      ...(date && date !== "N/A" ? { date: date.replace(/T00:00:00(\.000)?Z$/, "") } : {}),
    })
  }
  return out
}

/**
 * Exa's hosted MCP server (Streamable HTTP, stateless: no initialize needed). Free without
 * a key, rate-limited; an Exa key raises the limit.
 */
export const exa: Backend = async (q, ctx) => {
  const url = new URL(ctx.settings.exa?.url ?? EXA_URL)
  const keyEnv = ctx.settings.exa?.apiKeyEnv
  const key = keyEnv ? ctx.env[keyEnv] : undefined
  if (keyEnv && !key) throw new SearchError(`Exa: the environment variable ${keyEnv} is not set`)
  const scope = [
    q.allowedDomains.length ? `Only results from ${q.allowedDomains.join(", ")}.` : "",
    q.blockedDomains.length ? `No results from ${q.blockedDomains.join(", ")}.` : "",
  ]
  const res = await ctx.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      // Exa documents the key as this header (a URL parameter would also end up in logs).
      ...(key ? { "x-api-key": key } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query: q.query,
          // The server allows at most 4096 characters.
          objective: [`Find pages answering: ${q.query}`, ...scope].filter(Boolean).join(" ").slice(0, 4000),
          numResults: overfetch(q),
        },
      },
    }),
    signal: ctx.signal,
  })
  if (!res.ok) {
    const err = await httpError("Exa", res)
    // Never echo the URL: it may carry the key.
    throw res.status === 429
      ? new SearchError(`Exa's free rate limit was hit (HTTP 429). ${err.message}`)
      : err
  }
  const msg = await mcpResponse(res)
  const error = msg.error as { message?: string } | undefined
  if (error) throw new SearchError(`Exa: ${error.message ?? JSON.stringify(error)}`)
  const result = msg.result as { content?: { type?: string; text?: string }[]; isError?: boolean } | undefined
  const text = (result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n\n---\n\n")
  if (result?.isError) throw new SearchError(`Exa: ${text.slice(0, 300) || "the search failed"}`)
  return parseExaText(text)
}

export const BACKENDS: Record<WebSearchBackend, Backend> = { exa, brave, tavily, searxng }

export interface SearchOutcome {
  backend: WebSearchBackend
  results: SearchResult[]
  /** Backends that failed before this one, with why. */
  failures: string[]
}

/**
 * Tries the configured backend, then each fallback, until one answers. An empty result
 * list is an answer, not a failure. Throws a SearchError listing every failure.
 */
export async function search(
  q: SearchQuery,
  ctx: Omit<BackendContext, "signal">,
  signal: AbortSignal,
  backends: Record<WebSearchBackend, Backend> = BACKENDS,
): Promise<SearchOutcome> {
  const chain = [...new Set([ctx.settings.backend ?? "exa", ...(ctx.settings.fallback ?? [])])]
  const timeoutMs = ctx.settings.timeoutMs ?? 20_000
  const failures: string[] = []
  for (const name of chain) {
    signal.throwIfAborted()
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      const found = await backends[name](q, { ...ctx, signal: AbortSignal.any([signal, timeout]) })
      return { backend: name, results: filterResults(found, q), failures }
    } catch (err) {
      if (signal.aborted) throw signal.reason ?? err
      const why = timeout.aborted
        ? `timed out after ${timeoutMs} ms`
        : err instanceof SearchError
          ? err.message
          : `request failed: ${err instanceof Error ? err.message : String(err)}`
      failures.push(`${name}: ${why}`)
    }
  }
  throw new SearchError(`web search failed.\n${failures.map((f) => `- ${f}`).join("\n")}`)
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s)

export function renderResults(query: string, outcome: SearchOutcome): string {
  const head = `Search results for "${query}" (via ${outcome.backend}):`
  const notes = outcome.failures.length ? `\n(Tried first: ${outcome.failures.join("; ")})` : ""
  if (!outcome.results.length) return `${head}${notes}\n\nNo results.`
  const items = outcome.results.map((r, i) => {
    const lines = [`${i + 1}. ${r.title.replace(/\s+/g, " ").trim()}`, `   ${r.url}`]
    if (r.date) lines.push(`   Published: ${r.date}`)
    const snippet = clip(r.snippet.replace(/\s+/g, " ").trim(), 1200)
    if (snippet) lines.push(`   ${snippet}`)
    return lines.join("\n")
  })
  return `${head}${notes}\n\n${items.join("\n\n")}`
}
