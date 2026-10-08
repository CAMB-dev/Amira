import {
  DEFAULT_WEB_FETCH_ALLOW_PRIVATE_NETWORK,
  DEFAULT_WEB_FETCH_MAX_BYTES,
  DEFAULT_WEB_FETCH_MAX_CHARS,
  DEFAULT_WEB_FETCH_TIMEOUT_MS,
  DEFAULT_WEB_SEARCH_MAX_RESULTS,
  defineExtension,
  defineTool,
  type ExtensionAPI,
  type Resolver,
  textResult,
  type WebSettings,
} from "@amira/api"
import { FetchError, fetchPage, PageCache, parseUrl, renderPage } from "./fetch.ts"
import { webFetchPresenter, webSearchPresenter } from "./presenters.ts"
import { normalizeDomain, renderResults, SearchError, search } from "./search.ts"

export { isPrivateAddress } from "@amira/api"
export { htmlToMarkdown } from "./html.ts"
export { BACKENDS, parseExaText } from "./search.ts"
export { webFetchPresenter, webSearchPresenter }

export const WEB_SEARCH_TOOL = "web_search"
export const WEB_FETCH_TOOL = "web_fetch"

const LARGEST_MAX_CHARS = 100_000

export interface WebExtensionOptions {
  /** For tests: the network and name resolution. */
  fetch?: typeof fetch
  resolve?: Resolver
  env?: Record<string, string | undefined>
  cache?: PageCache
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function domains(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .filter((d) => typeof d === "string")
        .map(normalizeDomain)
        .filter(Boolean)
    : []
}

export function webTools(settings: WebSettings, opts: WebExtensionOptions = {}) {
  const searchSettings = settings.search ?? {}
  const fetchSettings = settings.fetch ?? {}
  const cache = opts.cache ?? new PageCache()
  const doFetch = opts.fetch ?? fetch
  const env = opts.env ?? process.env

  const webSearch = defineTool<{
    query: string
    maxResults?: number
    allowedDomains?: string[]
    blockedDomains?: string[]
  }>({
    name: WEB_SEARCH_TOOL,
    description: [
      "Searches the web and returns numbered results: title, URL, publication date when known, and a snippet.",
      "Use it for anything that may have changed since your training data: news, releases, current versions, prices, docs of recent tools. The current date is in the system prompt; put the year in queries about recent events instead of assuming your training cutoff is now.",
      "Snippets are short. To read a page, call web_fetch with its URL.",
      "When you use what you found, cite the URLs of the pages you relied on in your answer.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: `How many results to return (default ${searchSettings.maxResults ?? DEFAULT_WEB_SEARCH_MAX_RESULTS}).`,
        },
        allowedDomains: {
          type: "array",
          items: { type: "string" },
          description: 'Only return results from these domains and their subdomains, e.g. ["bun.com"].',
        },
        blockedDomains: {
          type: "array",
          items: { type: "string" },
          description: "Never return results from these domains and their subdomains.",
        },
      },
      required: ["query"],
    },
    traits: { readOnly: true },
    concurrency: "parallel",
    // A model that searches on the provider's side (hosted web search) does not get this one.
    supersededBy: "webSearch",
    async execute(p, ctx) {
      const query = typeof p.query === "string" ? p.query.trim() : ""
      if (!query) return textResult("web_search needs a non-empty query", true)
      const requested = Number.isInteger(p.maxResults) ? (p.maxResults as number) : undefined
      const maxResults = Math.min(
        20,
        Math.max(1, requested ?? searchSettings.maxResults ?? DEFAULT_WEB_SEARCH_MAX_RESULTS),
      )
      const q = {
        query,
        maxResults,
        allowedDomains: domains(p.allowedDomains),
        blockedDomains: domains(p.blockedDomains),
      }
      try {
        const outcome = await search(q, { fetch: doFetch, env, settings: searchSettings }, ctx.signal)
        return { content: [{ type: "text", text: renderResults(query, outcome) }], details: outcome }
      } catch (err) {
        if (ctx.signal.aborted) throw err
        return textResult(
          err instanceof SearchError ? err.message : `web search failed: ${message(err)}`,
          true,
        )
      }
    },
  })

  const maxChars = fetchSettings.maxChars ?? DEFAULT_WEB_FETCH_MAX_CHARS
  const webFetch = defineTool<{ url: string; prompt?: string; maxChars?: number; offset?: number }>({
    name: WEB_FETCH_TOOL,
    description: [
      "Fetches a web page (http or https) and returns its content as Markdown; JSON and plain text come back as text. PDFs and other binary files are not supported.",
      "Redirects are followed and the final URL is reported. Long pages are cut: the result ends with the offset to pass to read the next part. Pages are cached for 15 minutes, so paging does not refetch.",
      "Local and private-network addresses are refused.",
      "Cite the URL when you use what a page says.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL, including https://." },
        prompt: {
          type: "string",
          description:
            "What you are looking for on the page. When the page is cut, the result lists later passages that mention it, with their offsets.",
        },
        maxChars: {
          type: "integer",
          minimum: 1,
          maximum: LARGEST_MAX_CHARS,
          description: `Most characters to return (default ${maxChars}).`,
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Character offset to start from, to read on after a cut result (default 0).",
        },
      },
      required: ["url"],
    },
    traits: { readOnly: true },
    concurrency: "parallel",
    async execute(p, ctx) {
      const limit = Math.min(
        LARGEST_MAX_CHARS,
        Math.max(1, Number.isInteger(p.maxChars) ? (p.maxChars as number) : maxChars),
      )
      const offset = Number.isInteger(p.offset) ? Math.max(0, p.offset as number) : 0
      try {
        const url = parseUrl(typeof p.url === "string" ? p.url : "").href
        let page = cache.get(url)
        if (!page) {
          page = await fetchPage(
            url,
            {
              maxBytes: fetchSettings.maxBytes ?? DEFAULT_WEB_FETCH_MAX_BYTES,
              timeoutMs: fetchSettings.timeoutMs ?? DEFAULT_WEB_FETCH_TIMEOUT_MS,
              allowPrivateNetwork:
                fetchSettings.allowPrivateNetwork ?? DEFAULT_WEB_FETCH_ALLOW_PRIVATE_NETWORK,
              fetch: doFetch,
              ...(opts.resolve ? { resolve: opts.resolve } : {}),
            },
            ctx.signal,
          )
          cache.set(url, page)
        }
        const prompt = typeof p.prompt === "string" ? p.prompt : undefined
        return {
          content: [{ type: "text", text: renderPage(page, offset, limit, prompt) }],
          details: { url: page.url, finalUrl: page.finalUrl, status: page.status, length: page.text.length },
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err
        return textResult(err instanceof FetchError ? err.message : `web_fetch failed: ${message(err)}`, true)
      }
    },
  })

  return { webSearch, webFetch }
}

export function createWebExtension(opts: WebExtensionOptions = {}) {
  return defineExtension((api: ExtensionAPI) => {
    const { webSearch, webFetch } = webTools(api.settings.web ?? {}, opts)
    api.registerTool(webSearch)
    api.registerTool(webFetch)
    api.registerToolRenderer(WEB_SEARCH_TOOL, webSearchPresenter)
    api.registerToolRenderer(WEB_FETCH_TOOL, webFetchPresenter)
  })
}

export default createWebExtension()
