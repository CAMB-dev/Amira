import type { AssistantContent, Citation, Message, ModelInfo, ServerToolBlock, StreamEvent } from "./types.ts"

/** Dialects with a hosted web search the provider runs itself. */
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

/** Where a request goes, which decides whether a server tool's item may be sent back as it is. */
export interface ServerToolTarget {
  dialect: string
  provider: string
  host: string
}

/**
 * History as `target` may receive it: server-tool blocks that did not come from the same
 * dialect, provider and host become text notes (serverToolText), so the model still knows
 * what was searched. Unchanged messages are kept; changed ones are copies.
 */
export function adaptServerTools(messages: Message[], target: ServerToolTarget): Message[] {
  let changed = false
  const out = messages.map((m): Message => {
    if (m.role !== "assistant" || !m.content.some((b) => b.type === "serverTool")) return m
    const stale = (b: AssistantContent) =>
      b.type === "serverTool" && !canReplayServerTool(b, target, m.model.provider)
    if (!m.content.some(stale)) return m
    changed = true
    const content = m.content.map(
      (b): AssistantContent =>
        b.type === "serverTool" && stale(b) ? { type: "text", text: serverToolText(b) } : b,
    )
    return { ...m, content }
  })
  return changed ? out : messages
}

/** A block goes back as it is only to the dialect, provider and host that produced it. */
export function canReplayServerTool(b: ServerToolBlock, target: ServerToolTarget, producer: string): boolean {
  const sig = b.signature
  return (
    sig !== undefined &&
    sig.dialect === target.dialect &&
    sig.host !== undefined &&
    sig.host === target.host &&
    producer === target.provider
  )
}

/** A server tool's call as a short note, for a model that cannot take its item. */
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

/**
 * Stamps the host a reply came from on its server-tool blocks, so their items are only sent
 * back there (adaptServerTools).
 */
export async function* withServerToolHost(
  stream: AsyncIterable<StreamEvent>,
  host: string,
): AsyncGenerator<StreamEvent> {
  for await (const ev of stream) {
    if ((ev.type === "done" || ev.type === "error") && host) {
      for (const b of ev.message.content) {
        if (b.type === "serverTool" && b.signature && b.signature.host === undefined) b.signature.host = host
      }
    }
    yield ev
  }
}
