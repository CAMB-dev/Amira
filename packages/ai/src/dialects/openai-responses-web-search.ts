import { NATIVE_WEB_SEARCH } from "../server-tools.ts"
import type { AssistantMessage, Citation, ServerToolBlock, StreamEvent, TextBlock } from "../types.ts"
import { RESPONSES_DIALECT } from "./openai-responses-input.ts"

/**
 * The hosted web search's part of a Responses stream: `web_search_call` output items become
 * server-tool blocks in output order, and `url_citation` annotations become the citations of
 * the text they annotate. A search is never a function call: nothing runs here and nothing is
 * sent back for it but its own item.
 */
export class ResponsesWebSearch {
  readonly #calls = new Map<string, ServerToolBlock>()

  /** `current` is the message being built, which the blocks join in output order. */
  constructor(private readonly current: () => AssistantMessage) {}

  /** A web_search_call item was added or finished. */
  *item(key: string, item: any, done: boolean): Generator<StreamEvent> {
    const block = this.#blockFor(key, item)
    if (done) {
      const action = item?.action
      if (action && typeof action === "object") {
        const { sources, ...input } = action
        block.input = input
        const found = sourcesOf(sources)
        if (found.length) block.sources = found
      }
      block.status = item?.status === "failed" ? "failed" : "done"
      block.signature = { dialect: RESPONSES_DIALECT, value: JSON.stringify(item) }
    } else if (item?.status === "failed") block.status = "failed"
    yield snapshot(block)
  }

  /**
   * response.web_search_call.* status events. The search counts as done once its item is,
   * which says what was searched; these only start it, for servers that skip the added item.
   */
  *event(ev: any, key: string): Generator<StreamEvent> {
    if (this.#calls.has(key)) return
    yield snapshot(this.#blockFor(key, { id: ev?.item_id }))
  }

  /** An annotation streamed in for a text block. */
  annotation(block: TextBlock | undefined, annotation: unknown) {
    const c = citationOf(annotation, 0)
    if (!block || !c) return
    const list = block.citations ?? []
    if (!list.some((k) => k.url === c.url && k.start === c.start && k.end === c.end)) list.push(c)
    block.citations = list
  }

  /**
   * An output message finished: its annotations, over all its parts, are the text block's
   * citations. Spans of later parts count from the start of the block's text.
   */
  message(block: TextBlock | undefined, item: any) {
    if (!block) return
    const citations: Citation[] = []
    let offset = 0
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      for (const a of Array.isArray(part?.annotations) ? part.annotations : []) {
        const c = citationOf(a, offset)
        if (c) citations.push(c)
      }
      if (typeof part?.text === "string") offset += part.text.length
      else if (typeof part?.refusal === "string") offset += part.refusal.length
    }
    if (citations.length) block.citations = citations
  }

  #blockFor(key: string, item: any): ServerToolBlock {
    let block = this.#calls.get(key)
    if (!block) {
      const id = typeof item?.id === "string" && item.id ? item.id : key
      block = { type: "serverTool", id, name: NATIVE_WEB_SEARCH, input: {}, status: "running" }
      this.#calls.set(key, block)
      this.current().content.push(block)
    }
    return block
  }
}

function snapshot(block: ServerToolBlock): StreamEvent {
  const { signature: _, ...rest } = block
  return {
    type: "serverTool",
    block: { ...rest, input: { ...block.input }, ...(block.sources ? { sources: [...block.sources] } : {}) },
  }
}

function sourcesOf(v: unknown): { url: string; title?: string }[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((s) =>
    typeof s?.url === "string" && s.url
      ? [{ url: s.url, ...(typeof s.title === "string" && s.title ? { title: s.title } : {}) }]
      : [],
  )
}

function citationOf(a: any, offset: number): Citation | undefined {
  if (a?.type !== "url_citation" || typeof a.url !== "string" || !a.url) return undefined
  return {
    url: a.url,
    ...(typeof a.title === "string" && a.title ? { title: a.title } : {}),
    ...(typeof a.start_index === "number" ? { start: a.start_index + offset } : {}),
    ...(typeof a.end_index === "number" ? { end: a.end_index + offset } : {}),
  }
}
