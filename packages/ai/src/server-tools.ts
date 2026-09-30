import type { AssistantContent, Citation, ModelInfo, ServerToolBlock } from "./types.ts"

/** Dialects with a hosted web search the provider runs itself (ids spelled out: the dialects import this file). */
const WEB_SEARCH_DIALECTS = new Set(["openai-responses"])

/** The name a hosted web search goes by, in blocks and in frontends. */
export const NATIVE_WEB_SEARCH = "web_search"

/**
 * Whether requests for `model` offer the provider's hosted web search: its caps say so
 * (ProviderCompat.webSearch), it takes tools natively, and its dialect has one. The client
 * web_search tool is hidden from such a model.
 */
export function hasNativeWebSearch(model: Pick<ModelInfo, "dialect" | "caps">): boolean {
  return (
    model.caps.webSearch === true && model.caps.tools === "native" && WEB_SEARCH_DIALECTS.has(model.dialect)
  )
}

/**
 * Markers of Azure OpenAI base URLs (the ones Codex uses to tell one), besides api.openai.com:
 * the vendor's own Responses endpoints, where hosted web search is on by default.
 */
const AZURE_MARKERS = [
  "openai.azure.",
  "cognitiveservices.azure.",
  "aoai.azure.",
  "azure-api.",
  "azurefd.",
  "windows.net/openai",
]

export function isOpenAIVendorUrl(baseUrl: string): boolean {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  if (url.hostname.toLowerCase() === "api.openai.com") return true
  const where = `${url.hostname}${url.pathname}`.toLowerCase()
  return AZURE_MARKERS.some((m) => where.includes(m))
}

/** Hosted web search's default for a provider without a setting: on at the vendor's own endpoints. */
export function defaultWebSearch(dialect: string, baseUrl: string): boolean {
  return WEB_SEARCH_DIALECTS.has(dialect) && isOpenAIVendorUrl(baseUrl)
}

/**
 * A server tool's call as a short note, for a model that cannot take its item: another
 * dialect, or one the ai client left no item for (forReplay, canReplayServerTool).
 */
export function serverToolText(b: ServerToolBlock): string {
  const what = describeServerTool(b)
  const sources = (b.sources ?? []).map((s) => `- ${s.title ? `${s.title}: ` : ""}${s.url}`)
  const status = b.status === "failed" ? " (failed)" : b.status === "running" ? " (did not finish)" : ""
  return [`[${what}${status}]`, ...(sources.length ? ["Sources:", ...sources] : [])].join("\n")
}

/** "Web search: \"node lts\"", "Web search opened https://…", for notes and frontends. */
export function describeServerTool(b: Pick<ServerToolBlock, "name" | "input">): string {
  const label = b.name === NATIVE_WEB_SEARCH ? "Web search" : b.name
  const input = b.input
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "")
  const queries = Array.isArray(input.queries)
    ? input.queries.filter((q): q is string => typeof q === "string" && q !== "")
    : []
  if (input.type === "open_page" && str("url")) return `${label}: opened ${str("url")}`
  if (input.type === "find_in_page" && str("url")) {
    return `${label}: looked for "${str("pattern")}" in ${str("url")}`
  }
  const all = queries.length ? queries : str("query") ? [str("query")] : []
  return all.length ? `${label}: ${all.map((q) => `"${q}"`).join(", ")}` : label
}

/** The citations of a message's text blocks, one per URL, in the order first cited. */
export function messageCitations(content: readonly AssistantContent[]): Citation[] {
  const seen = new Map<string, Citation>()
  for (const b of content) {
    if (b.type !== "text") continue
    for (const c of b.citations ?? []) {
      const known = seen.get(c.url)
      if (!known) seen.set(c.url, { url: c.url, ...(c.title ? { title: c.title } : {}) })
      else if (!known.title && c.title) known.title = c.title
    }
  }
  return [...seen.values()]
}
