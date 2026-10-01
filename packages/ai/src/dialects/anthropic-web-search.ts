import { NATIVE_WEB_SEARCH, serverToolSnapshot } from "../server-tools.ts"
import type { ServerToolBlock, StreamEvent, TextBlock } from "../types.ts"

const DIALECT = "anthropic-messages"

/**
 * The basic version everywhere: later ones add only dynamic filtering (searches run from code
 * execution, whose blocks Amira does not handle) and response inclusion for those, so with
 * direct calls they behave the same while fewer hosts and models accept them.
 */
export const ANTHROPIC_SEARCH_TOOL = { type: "web_search_20250305", name: NATIVE_WEB_SEARCH, max_uses: 5 }

export interface SearchReplay {
  call: Record<string, any>
  result?: Record<string, any>
  /** Number of message blocks between the call and its result, for interleaved searches. */
  resultAfter?: number
  resultOrder?: number
}

export function decodeSearchReplay(value: string): SearchReplay | undefined {
  try {
    const v = JSON.parse(value)
    if (v?.call?.type === "server_tool_use" && v.call.name === NATIVE_WEB_SEARCH) return v
  } catch {}
  return undefined
}

/** Keeps encrypted_content and every result field inside the existing opaque signature. */
export function searchResult(block: ServerToolBlock, result: any, after: number, order: number): StreamEvent {
  block.status = result?.content?.type === "web_search_tool_result_error" ? "failed" : "done"
  if (block.status === "failed") block.input = { ...block.input, error_code: result.content.error_code }
  if (Array.isArray(result?.content)) {
    block.sources = result.content.flatMap((r: any) =>
      r?.type === "web_search_result" && typeof r.url === "string" && r.url
        ? [{ url: r.url, ...(typeof r.title === "string" ? { title: r.title } : {}) }]
        : [],
    )
  }
  const replay = block.signature && decodeSearchReplay(block.signature.value)
  if (replay)
    block.signature!.value = JSON.stringify({ ...replay, result, resultAfter: after, resultOrder: order })
  return serverToolSnapshot(block)
}

/** Citations have no answer-text offsets in Messages; cited_text is source text, not a span. */
export function searchCitations(block: TextBlock, raw: Record<string, any>) {
  const citations = (Array.isArray(raw.citations) ? raw.citations : []).flatMap((c: any) =>
    c?.type === "web_search_result_location" && typeof c.url === "string" && c.url
      ? [{ url: c.url, ...(typeof c.title === "string" ? { title: c.title } : {}) }]
      : [],
  )
  if (!citations.length) return
  block.citations = citations
  block.signature = { dialect: DIALECT, kind: "webSearch", value: JSON.stringify(raw) }
}

export function decodeSearchText(value: string): Record<string, any> | undefined {
  try {
    const v = JSON.parse(value)
    if (v?.type === "text" && typeof v.text === "string" && Array.isArray(v.citations)) return v
  } catch {}
  return undefined
}
