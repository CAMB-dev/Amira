import * as shared from "@amira/ai-shared"
import type { AssistantContent, Citation, ModelInfo, ServerToolBlock, StreamEvent } from "./types.ts"

/** Dialects with a hosted web search the provider runs itself (ids spelled out: the dialects import this file). */
const WEB_SEARCH_DIALECTS = new Set(["openai-responses", "anthropic-messages", "google-gemini"])

export { NATIVE_WEB_SEARCH } from "@amira/ai-shared"

/**
 * Whether requests for `model` offer the provider's hosted web search: its caps say so
 * (ProviderCompat.webSearch), it takes tools natively, and its dialect has one. The client
 * web_search tool is hidden from such a model. With function tools (the default, also used
 * by tool hiding), Gemini must be a Gemini 3 model.
 */
export function hasNativeWebSearch(
  model: Pick<ModelInfo, "dialect" | "caps"> & Partial<Pick<ModelInfo, "id">>,
  functionTools = true,
): boolean {
  return (
    model.caps.webSearch === true &&
    model.caps.tools === "native" &&
    WEB_SEARCH_DIALECTS.has(model.dialect) &&
    (model.dialect !== "google-gemini" || !functionTools || isGemini3(model.id ?? ""))
  )
}

/** Only Gemini 3 documents combining Google Search with function declarations. */
export function isGemini3(id: string): boolean {
  return /^(?:models\/)?gemini-3(?:[.-]|$)/.test(id)
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
  if (dialect === "openai-responses") return isOpenAIVendorUrl(baseUrl)
  let host: string
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return false
  }
  if (dialect === "anthropic-messages") return host === "api.anthropic.com"
  // This dialect builds Developer API URLs and does not implement Vertex authentication/routes.
  return dialect === "google-gemini" && host === "generativelanguage.googleapis.com"
}

/** A UI snapshot never exposes opaque provider replay data. */
export function serverToolSnapshot(block: ServerToolBlock): StreamEvent {
  const { signature: _, ...rest } = block
  return {
    type: "serverTool",
    block: {
      ...rest,
      input: { ...block.input },
      ...(block.sources ? { sources: [...block.sources] } : {}),
      ...(block.searchEntryPoint ? { searchEntryPoint: { ...block.searchEntryPoint } } : {}),
    },
  }
}

/**
 * A server tool's call as a short note, for a model that cannot take its item: another
 * dialect, or one the ai client left no item for (forReplay, canReplayServerTool).
 */
export const serverToolText: (b: ServerToolBlock) => string = shared.serverToolText

/** "Web search: \"node lts\"", "Web search opened https://…", for notes and frontends. */
export const describeServerTool: (b: Pick<ServerToolBlock, "name" | "input">) => string =
  shared.describeServerTool

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
