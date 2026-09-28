import type { AssistantMessage, ImageBlock, Message, ToolCallBlock, ToolResultMessage } from "../types.ts"
import { MISSING_RESULT, resultText, ToolResults } from "./tool-results.ts"

export const GEMINI_DIALECT = "google-gemini"

/** Prefix of the ids made up for calls, since Gemini's calls have none. */
export const SYNTHETIC_ID = "gemini_call_"

export type GeminiPart = {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { id?: string; name: string; args: Record<string, unknown> }
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> }
}

export interface GeminiContent {
  role: "user" | "model"
  parts: GeminiPart[]
}

export interface GeminiContentOptions {
  /** Whether the model accepts images; tool-result images then follow the responses. */
  images?: boolean
}

/**
 * Translates history to Gemini contents. Calls are matched by name and position, so each
 * model turn with calls is followed by one user turn answering them in order.
 */
export function toGeminiContents(messages: Message[], opts: GeminiContentOptions = {}): GeminiContent[] {
  const out: GeminiContent[] = []
  const results = new ToolResults(messages)
  messages.forEach((m, i) => {
    if (m.role === "user") {
      out.push({
        role: "user",
        parts: m.content.map((b) => (b.type === "text" ? { text: b.text } : imagePart(b))),
      })
      return
    }
    if (m.role !== "assistant") return
    const parts = modelParts(m)
    if (!parts.length) return
    out.push({ role: "model", parts })
    const calls = m.content.filter((b) => b.type === "toolCall")
    if (!calls.length) return
    const responses: GeminiPart[] = []
    const images: GeminiPart[] = []
    for (const call of calls) {
      const result = results.take(call.id, i)
      responses.push(responsePart(call, result, opts))
      const shots = result?.content.filter((b) => b.type === "image") ?? []
      if (opts.images && result && shots.length) {
        images.push({ text: `Images from the ${result.toolName} result:` }, ...shots.map(imagePart))
      }
    }
    out.push({ role: "user", parts: [...responses, ...images] })
  })
  return out
}

/**
 * A signature that arrived on a text or call part is stored as a redacted thinking block
 * right after that block, and goes back onto the part before it.
 */
function modelParts(m: AssistantMessage): GeminiPart[] {
  const parts: GeminiPart[] = []
  for (const b of m.content) {
    if (b.type === "text") {
      if (b.text) parts.push({ text: b.text })
    } else if (b.type === "toolCall") {
      parts.push({ functionCall: { ...(isSynthetic(b.id) ? {} : { id: b.id }), name: b.name, args: b.args } })
    } else if (b.signature?.dialect === GEMINI_DIALECT) {
      const sig = b.signature.value
      const prev = parts.at(-1)
      // Thoughts are marked as Gemini's even without a signature, so they come back as thoughts.
      if (!b.redacted) parts.push({ text: b.text, thought: true, ...(sig ? { thoughtSignature: sig } : {}) })
      else if (prev && !prev.thoughtSignature) prev.thoughtSignature = sig
      else parts.push({ text: "", thoughtSignature: sig })
    }
  }
  return parts
}

function responsePart(
  call: ToolCallBlock,
  result: ToolResultMessage | undefined,
  opts: GeminiContentOptions,
) {
  const text = result ? resultText(result, opts.images ? ", sent after the responses" : "") : MISSING_RESULT
  const response = result && !result.isError ? { output: text } : { error: text }
  return {
    functionResponse: { ...(isSynthetic(call.id) ? {} : { id: call.id }), name: call.name, response },
  }
}

function isSynthetic(id: string): boolean {
  return id.startsWith(SYNTHETIC_ID)
}

function imagePart(b: ImageBlock): GeminiPart {
  return { inlineData: { mimeType: b.mimeType, data: b.data } }
}
