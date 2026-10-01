import { isGemini3, NATIVE_WEB_SEARCH, serverToolSnapshot } from "../server-tools.ts"
import type { AssistantMessage, ServerToolBlock, StreamEvent, TextBlock, ThinkingBlock } from "../types.ts"

const DIALECT = "google-gemini"

interface SearchReplay {
  call: Record<string, any>
  result?: Record<string, any>
  resultAfter?: number
  resultOrder?: number
}

export function decodeSearchReplay(value: string): SearchReplay | undefined {
  try {
    const v = JSON.parse(value)
    if (v?.call?.toolCall?.toolType === "GOOGLE_SEARCH_WEB") return v
  } catch {}
  return undefined
}

/** Grounding chunks are incremental; support indices address the accumulated list. */
export class GeminiWebSearch {
  readonly #calls = new Map<string, ServerToolBlock>()
  readonly #raw = new Map<string, any>()
  readonly #chunks: any[] = []
  readonly #supports: any[] = []
  readonly #queries = new Set<string>()
  readonly #parts: { block?: TextBlock | ThinkingBlock; text: string; offset: number }[] = []
  #metadata: ServerToolBlock | undefined
  #firstPart = true

  constructor(private readonly message: AssistantMessage) {}

  beginChunk() {
    this.#firstPart = true
  }

  /** Text chunks extend one logical Part until a signature or another kind of part separates it. */
  part(part: any, block?: TextBlock | ThinkingBlock) {
    const prev = this.#parts.at(-1)
    const text = typeof part.text === "string" ? part.text : ""
    const continuation = this.#firstPart
    this.#firstPart = false
    if (continuation && block && prev?.block === block) prev.text += text
    else
      this.#parts.push({
        block,
        text,
        offset: block
          ? new TextEncoder().encode(block.text.slice(0, block.text.length - text.length)).length
          : 0,
      })
  }

  *serverPart(part: any): Generator<StreamEvent> {
    const call = part.toolCall
    const result = part.toolResponse
    if ((call ?? result)?.toolType !== "GOOGLE_SEARCH_WEB") return
    if (call) {
      const id = typeof call.id === "string" && call.id ? call.id : `gemini_search_${this.#calls.size}`
      const block: ServerToolBlock = {
        type: "serverTool",
        id,
        name: NATIVE_WEB_SEARCH,
        input: call.args && typeof call.args === "object" ? { ...call.args } : {},
        status: "running",
      }
      // The call is signed only once its response arrives; incomplete pairs become a note.
      this.#calls.set(id, block)
      this.message.content.push(block)
      yield serverToolSnapshot(block)
      this.#raw.set(id, part)
    } else {
      const pending = [...this.#calls.values()].filter((b) => b.status === "running")
      const id =
        typeof result.id === "string" && result.id
          ? result.id
          : pending.length === 1
            ? pending[0]!.id
            : undefined
      const block = id === undefined ? undefined : this.#calls.get(id)
      if (!block || id === undefined) return
      block.status = "done"
      block.signature = {
        dialect: DIALECT,
        value: JSON.stringify({
          call: this.#raw.get(id),
          result: part,
          resultAfter: this.message.content.length - this.message.content.indexOf(block) - 1,
          resultOrder: this.#parts.length,
        }),
      }
      yield serverToolSnapshot(block)
    }
  }

  *metadata(raw: any): Generator<StreamEvent> {
    if (!raw || typeof raw !== "object") return
    if (Array.isArray(raw.groundingChunks)) this.#chunks.push(...raw.groundingChunks)
    if (Array.isArray(raw.groundingSupports)) this.#supports.push(...raw.groundingSupports)
    for (const q of Array.isArray(raw.webSearchQueries) ? raw.webSearchQueries : []) {
      if (typeof q === "string" && q.trim()) this.#queries.add(q)
    }
    const sources = this.#chunks.flatMap((c) =>
      typeof c?.web?.uri === "string" && c.web.uri
        ? [{ url: c.web.uri, ...(typeof c.web.title === "string" ? { title: c.web.title } : {}) }]
        : [],
    )
    if (!sources.length && !this.#queries.size && !raw.searchEntryPoint) return
    let block = [...this.#calls.values()].at(-1) ?? this.#metadata
    if (!block) {
      block = {
        type: "serverTool",
        id: "gemini_grounding",
        name: NATIVE_WEB_SEARCH,
        input: {},
        status: "done",
      }
      this.#metadata = block
      this.message.content.push(block)
    }
    if (block === this.#metadata) block.input = { queries: [...this.#queries] }
    if (sources.length) block.sources = sources
    if (raw.searchEntryPoint && typeof raw.searchEntryPoint === "object") {
      const { renderedContent, sdkBlob } = raw.searchEntryPoint
      block.searchEntryPoint = {
        ...(typeof renderedContent === "string" ? { renderedContent } : {}),
        ...(typeof sdkBlob === "string" ? { sdkBlob } : {}),
      }
    }
    // Gemini 2.x bills per grounded prompt, so a query list is not a per-search usage count there.
    if (isGemini3(this.message.model.model) && Array.isArray(raw.webSearchQueries))
      this.message.usage!.webSearchRequests = this.#queries.size
    this.citations()
    yield serverToolSnapshot(block)
  }

  /** Applied again at EOF for metadata that preceded its text or sources. */
  citations() {
    for (const support of this.#supports) {
      const segment = support?.segment
      const part = this.#parts[segment?.partIndex ?? 0]
      const block = part?.block
      if (
        !part ||
        block?.type !== "text" ||
        !Number.isInteger(segment?.startIndex) ||
        !Number.isInteger(segment?.endIndex)
      )
        continue
      const start = segment.startIndex
      const end = segment.endIndex
      const bytes = new TextEncoder().encode(part.text)
      if (start < 0 || end < start || end > bytes.length) continue
      // Gemini ranges are UTF-8 byte offsets; Amira keeps the same offsets in the merged block.
      const offset = part.offset
      for (const index of Array.isArray(support.groundingChunkIndices) ? support.groundingChunkIndices : []) {
        const web = this.#chunks[index]?.web
        if (!Number.isInteger(index) || typeof web?.uri !== "string" || !web.uri) continue
        const citation = {
          url: web.uri,
          ...(typeof web.title === "string" ? { title: web.title } : {}),
          start: offset + start,
          end: offset + end,
        }
        const list = block.citations ?? []
        if (!list.some((c) => c.url === citation.url && c.start === citation.start && c.end === citation.end))
          list.push(citation)
        block.citations = list
      }
    }
  }
}
