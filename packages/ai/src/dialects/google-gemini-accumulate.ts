import { parseToolArgs } from "../tool-args.ts"
import type {
  AssistantMessage,
  ModelError,
  ModelRef,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  Usage,
} from "../types.ts"
import { emptyUsage } from "../types.ts"
import { GEMINI_DIALECT, SYNTHETIC_ID } from "./google-gemini-contents.ts"
import { GeminiWebSearch } from "./google-gemini-web-search.ts"
import type { ErrorEvent } from "./http-stream.ts"

/** Finish reasons that mean the output was withheld. */
const FILTERED = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
])

/** Finish reasons where the same request may well succeed on a retry. */
const RETRYABLE = new Set(["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL"])

/**
 * Builds the assistant message from GenerateContentResponse chunks. Each chunk carries
 * whole parts; text and thoughts are merged into the open block of their kind.
 */
export class GeminiAccumulator {
  readonly message: AssistantMessage
  readonly #search: GeminiWebSearch
  /** The block the next text or thought part may extend. */
  #open: TextBlock | ThinkingBlock | undefined
  #calls = 0
  #finish: string | undefined
  #blocked: string | undefined
  readonly #tag = Math.random().toString(36).slice(2, 8)

  constructor(model: ModelRef) {
    this.message = { role: "assistant", content: [], model, usage: emptyUsage() }
    this.#search = new GeminiWebSearch(this.message)
  }

  *apply(chunk: any): Generator<StreamEvent> {
    if (chunk?.usageMetadata) this.message.usage = { ...this.message.usage, ...mapUsage(chunk.usageMetadata) }
    const block = chunk?.promptFeedback?.blockReason
    if (typeof block === "string" && block) this.#blocked = block
    const candidate = chunk?.candidates?.[0]
    const parts = candidate?.content?.parts
    if (Array.isArray(parts)) {
      this.#search.beginChunk()
      for (const part of parts) yield* this.#part(part ?? {})
    }
    yield* this.#search.metadata(candidate?.groundingMetadata)
    if (typeof candidate?.finishReason === "string" && candidate.finishReason)
      this.#finish = candidate.finishReason
  }

  fail(error: ModelError, retryable: boolean): ErrorEvent {
    this.#search.citations()
    this.message.stopReason = error.code === "aborted" ? "aborted" : "error"
    return { type: "error", error, retryable, message: this.message }
  }

  /** Closes the message: a done event, or an error when the output was blocked or cut off. */
  end(): StreamEvent {
    this.#search.citations()
    this.message.content = this.message.content.filter(
      (b) => b.type !== "thinking" || b.text || b.signature?.value,
    )
    if (this.#blocked) {
      return this.fail({ message: `the prompt was blocked (${this.#blocked})`, code: "blocked" }, false)
    }
    const finish = this.#finish
    if (!finish) return this.fail({ message: "the stream ended without a finish reason" }, true)
    if (finish === "MAX_TOKENS") {
      this.message.stopReason = "maxTokens"
      return { type: "done", message: this.message }
    }
    if (finish === "STOP") {
      this.message.stopReason = this.#calls ? "toolUse" : "end"
      return { type: "done", message: this.message }
    }
    // Anything else, such as SAFETY or MISSING_THOUGHT_SIGNATURE, did not end cleanly.
    const message = FILTERED.has(finish)
      ? `the provider filtered the output (finishReason: ${finish})`
      : `generation stopped early (finishReason: ${finish})`
    return this.fail({ message, code: finish.toLowerCase() }, RETRYABLE.has(finish))
  }

  *#part(part: any): Generator<StreamEvent> {
    const sig =
      typeof part.thoughtSignature === "string" && part.thoughtSignature ? part.thoughtSignature : undefined
    const text = typeof part.text === "string" ? part.text : ""
    if (part.toolCall || part.toolResponse) {
      this.#open = undefined
      this.#search.part(part)
      yield* this.#search.serverPart(part)
      return
    }
    if (part.functionCall) {
      this.#search.part(part)
      yield this.#call(part.functionCall)
    } else if (part.thought) {
      const block = this.#extend("thinking", text) as ThinkingBlock
      this.#search.part(part, block)
      if (text) yield { type: "thinking.delta", text }
      if (sig) {
        block.signature = { dialect: GEMINI_DIALECT, value: sig }
        this.#open = undefined
      }
      return
    } else if (text) {
      const block = this.#extend("text", text) as TextBlock
      this.#search.part(part, block)
      yield { type: "text.delta", text }
    } else this.#search.part(part)
    if (sig) {
      // The signature belongs to the part just added; see modelParts for the replay side.
      this.message.content.push({
        type: "thinking",
        text: "",
        redacted: true,
        signature: { dialect: GEMINI_DIALECT, value: sig },
      })
      this.#open = undefined
    }
  }

  #extend(kind: "text" | "thinking", text: string): TextBlock | ThinkingBlock {
    let block = this.#open
    if (block?.type !== kind) {
      // Thoughts are marked as Gemini's so a replay sends them back as thoughts, not text.
      block =
        kind === "text"
          ? { type: "text", text: "" }
          : { type: "thinking", text: "", signature: { dialect: GEMINI_DIALECT, value: "" } }
      this.message.content.push(block)
      this.#open = block
    }
    block.text += text
    return block
  }

  #call(fc: any): StreamEvent {
    this.#open = undefined
    const index = this.#calls++
    const id = typeof fc.id === "string" && fc.id ? fc.id : `${SYNTHETIC_ID}${this.#tag}_${index}`
    const name = typeof fc.name === "string" ? fc.name : ""
    const raw = fc.args === undefined ? "{}" : JSON.stringify(fc.args)
    this.message.content.push({ type: "toolCall", id, name, args: parseToolArgs(raw) })
    return { type: "toolCall.delta", index, id, name, argsDelta: raw }
  }
}

function mapUsage(u: any): Usage {
  const cached = u.cachedContentTokenCount ?? 0
  return {
    input: Math.max(0, (u.promptTokenCount ?? 0) - cached),
    output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    ...(typeof u.thoughtsTokenCount === "number" ? { reasoning: u.thoughtsTokenCount } : {}),
    cacheRead: cached,
    cacheWrite: 0,
  }
}
