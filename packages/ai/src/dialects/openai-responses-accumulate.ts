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
import type { ErrorEvent } from "./http-stream.ts"
import { responsesError } from "./openai-responses-errors.ts"
import {
  type CompactionItem,
  decodeCompaction,
  encodeMessage,
  encodeReasoning,
  type MessageSignature,
  RESPONSES_DIALECT,
} from "./openai-responses-input.ts"
import { ResponsesWebSearch } from "./openai-responses-web-search.ts"
import { madeUpIdPrefix } from "./tool-results.ts"

interface Call {
  index: number
  id: string
  name: string
  args: string
  done: boolean
}

interface Reasoning {
  block: ThinkingBlock
  /** Summary parts seen so far, so a new part starts on its own paragraph. */
  parts: Set<number>
}

/**
 * Builds the assistant message from Responses API stream events. Blocks keep the order of
 * output items; a tool call joins the message once its arguments are complete.
 */
export class ResponsesAccumulator {
  readonly message: AssistantMessage
  readonly #calls = new Map<string, Call>()
  readonly #idPrefix = madeUpIdPrefix()
  readonly #reasoning = new Map<string, Reasoning>()
  readonly #texts = new Map<string, TextBlock>()
  readonly #messages = new Map<string, MessageSignature>()
  readonly #webSearch = new ResponsesWebSearch(() => this.message)
  /** Compaction items the response produced (a compaction_trigger request should make one). */
  readonly compactions: CompactionItem[] = []
  readonly #onProgress: (() => void) | undefined
  #terminal: StreamEvent | undefined

  /** `onProgress` is called for the server's compaction progress events. */
  constructor(model: ModelRef, onProgress?: () => void) {
    this.message = { role: "assistant", content: [], model, usage: emptyUsage() }
    this.#onProgress = onProgress
  }

  /** The done or error event once the response has finished. */
  get terminal(): StreamEvent | undefined {
    return this.#terminal
  }

  *apply(ev: any): Generator<StreamEvent> {
    switch (ev?.type) {
      case "response.output_item.added":
        yield* this.#added(ev.item, ev.output_index)
        break
      case "response.output_item.done":
        if (ev.item?.type === "compaction") {
          // Only the done event carries the final encrypted content.
          const item = decodeCompaction(JSON.stringify(ev.item))
          if (item) this.compactions.push(item)
          break
        }
        yield* this.#itemDone(ev.item, ev.output_index)
        break
      // At most every 30 s while compacting; it carries no summary content.
      case "response.compaction.compacting":
        this.#onProgress?.()
        break
      case "response.output_text.delta":
      case "response.refusal.delta":
        yield* this.#text(itemKey(ev), ev.delta)
        break
      case "response.reasoning_summary_text.delta":
        yield* this.#thinking(itemKey(ev), ev.delta, ev.summary_index)
        break
      case "response.reasoning_text.delta":
        yield* this.#thinking(itemKey(ev), ev.delta, ev.content_index)
        break
      // A hosted web search runs on the server, inside the response: its completion is not the
      // response's, which goes on (the answer follows) until response.completed.
      case "response.web_search_call.in_progress":
      case "response.web_search_call.searching":
      case "response.web_search_call.completed":
        yield* this.#webSearch.event(ev, itemKey(ev))
        break
      case "response.output_text.annotation.added":
        this.#webSearch.annotation(this.#texts.get(itemKey(ev)), ev.annotation)
        break
      case "response.function_call_arguments.delta":
        yield* this.#args(itemKey(ev), ev.delta)
        break
      case "response.function_call_arguments.done": {
        const call = this.#calls.get(itemKey(ev))
        if (call && typeof ev.arguments === "string") call.args = ev.arguments
        break
      }
      case "response.completed":
        this.#usage(ev.response)
        this.#terminal = this.end()
        break
      case "response.incomplete":
        this.#usage(ev.response)
        this.#terminal = this.end(ev.response?.incomplete_details?.reason)
        break
      case "response.failed": {
        this.#usage(ev.response)
        const { error, retryable } = responsesError(ev.response?.error ?? "the response failed")
        this.#terminal = this.fail(error, retryable)
        break
      }
      case "error": {
        const { error, retryable } = responsesError(ev.error ?? { code: ev.code, message: ev.message })
        this.#terminal = this.fail(error, retryable)
        break
      }
    }
  }

  fail(error: ModelError, retryable: boolean): ErrorEvent {
    this.message.stopReason = error.code === "aborted" ? "aborted" : "error"
    return { type: "error", error, retryable, message: this.message }
  }

  /** Closes the message. Calls whose item never finished are kept with what arrived. */
  end(incomplete?: string): StreamEvent {
    for (const call of this.#calls.values()) this.#pushCall(call)
    this.message.content = this.message.content.filter((b) => b.type !== "thinking" || b.text || b.signature)
    const hasCalls = this.message.content.some((b) => b.type === "toolCall")
    if (incomplete === "content_filter") {
      return this.fail(
        { message: "the provider filtered the output (content_filter)", code: "content_filter" },
        false,
      )
    }
    if (incomplete === "max_output_tokens") this.message.stopReason = "maxTokens"
    else this.message.stopReason = hasCalls ? "toolUse" : "end"
    return { type: "done", message: this.message }
  }

  *#added(item: any, outputIndex: unknown): Generator<StreamEvent> {
    const key = itemKey({ item_id: item?.id, output_index: outputIndex })
    if (item?.type === "function_call") yield* this.#call(key, item)
    else if (item?.type === "reasoning") {
      const starts = !this.#reasoning.has(key)
      this.#reasoningFor(key)
      if (starts) yield { type: "thinking.start" }
    } else if (item?.type === "message") this.#noteMessage(key, item)
    else if (item?.type === "web_search_call") yield* this.#webSearch.item(key, item, false)
  }

  *#itemDone(item: any, outputIndex: unknown): Generator<StreamEvent> {
    const key = itemKey({ item_id: item?.id, output_index: outputIndex })
    if (item?.type === "function_call") {
      const call = yield* this.#call(key, item)
      if (!call.args && typeof item.arguments === "string" && item.arguments) {
        yield* this.#args(key, item.arguments)
      } else if (typeof item.arguments === "string") {
        call.args = item.arguments
      }
      this.#pushCall(call)
    } else if (item?.type === "reasoning") {
      const starts = !this.#reasoning.has(key)
      const r = this.#reasoningFor(key)
      if (starts) yield { type: "thinking.start" }
      if (!r.block.text) {
        const summary = (item.summary ?? [])
          .map((s: any) => s?.text ?? "")
          .filter(Boolean)
          .join("\n\n")
        if (summary) yield* this.#thinking(key, summary, 0)
      }
      if (typeof item.encrypted_content === "string" && item.encrypted_content) {
        r.block.signature = {
          dialect: RESPONSES_DIALECT,
          value: encodeReasoning({
            ...(typeof item.id === "string" ? { id: item.id } : {}),
            encrypted_content: item.encrypted_content,
          }),
        }
        if (!r.block.text) r.block.redacted = true
      }
    } else if (item?.type === "message") {
      this.#noteMessage(key, item)
      if (!this.#texts.has(key)) {
        // Servers that skip the deltas still send the whole message here.
        for (const part of item.content ?? []) {
          if (part?.type === "output_text" && part.text) yield* this.#text(key, part.text)
          else if (part?.type === "refusal" && part.refusal) yield* this.#text(key, part.refusal)
        }
      }
      this.#webSearch.message(this.#texts.get(key), item)
    } else if (item?.type === "web_search_call") {
      yield* this.#webSearch.item(key, item, true)
    }
  }

  /** Remembers an output message's id and phase so its text can be replayed as that item. */
  #noteMessage(key: string, item: any) {
    if (typeof item.id !== "string" || !item.id) return
    this.#messages.set(key, {
      id: item.id,
      ...(typeof item.phase === "string" && item.phase ? { phase: item.phase } : {}),
    })
    this.#sign(key)
  }

  #sign(key: string) {
    const block = this.#texts.get(key)
    const meta = this.#messages.get(key)
    if (block && meta) block.signature = { dialect: RESPONSES_DIALECT, value: encodeMessage(meta) }
  }

  *#text(key: string, delta: unknown): Generator<StreamEvent> {
    if (typeof delta !== "string" || !delta) return
    let block = this.#texts.get(key)
    if (!block) {
      block = { type: "text", text: "" }
      this.#texts.set(key, block)
      this.message.content.push(block)
      this.#sign(key)
    }
    block.text += delta
    yield { type: "text.delta", text: delta }
  }

  *#thinking(key: string, delta: unknown, part: unknown): Generator<StreamEvent> {
    const starts = !this.#reasoning.has(key)
    const r = this.#reasoningFor(key)
    if (starts) yield { type: "thinking.start" }
    if (typeof delta !== "string" || !delta) return
    const n = typeof part === "number" ? part : 0
    const text = !r.parts.has(n) && r.block.text ? `\n\n${delta}` : delta
    r.parts.add(n)
    r.block.text += text
    if (r.block.redacted) delete r.block.redacted
    yield { type: "thinking.delta", text }
  }

  #reasoningFor(key: string): Reasoning {
    let r = this.#reasoning.get(key)
    if (!r) {
      r = { block: { type: "thinking", text: "" }, parts: new Set() }
      this.#reasoning.set(key, r)
      this.message.content.push(r.block)
    }
    return r
  }

  *#call(key: string, item: any): Generator<StreamEvent, Call> {
    let call = this.#calls.get(key)
    if (!call) {
      call = { index: this.#calls.size, id: "", name: "", args: "", done: false }
      this.#calls.set(key, call)
    }
    const fresh = !call.id && !call.name
    if (typeof item?.call_id === "string" && item.call_id) call.id = item.call_id
    else if (!call.id)
      call.id = typeof item?.id === "string" && item.id ? item.id : `${this.#idPrefix}${call.index}`
    if (typeof item?.name === "string" && item.name) call.name = item.name
    if (fresh) {
      yield {
        type: "toolCall.delta",
        index: call.index,
        id: call.id,
        ...(call.name ? { name: call.name } : {}),
        argsDelta: "",
      }
    }
    return call
  }

  *#args(key: string, delta: unknown): Generator<StreamEvent> {
    if (typeof delta !== "string" || !delta) return
    const call = this.#calls.get(key) ?? (yield* this.#call(key, {}))
    call.args += delta
    yield {
      type: "toolCall.delta",
      index: call.index,
      id: call.id,
      ...(call.name ? { name: call.name } : {}),
      argsDelta: delta,
    }
  }

  #pushCall(call: Call) {
    if (call.done) return
    call.done = true
    this.message.content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      args: parseToolArgs(call.args),
    })
  }

  #usage(response: any) {
    const u = response?.usage
    if (u) this.message.usage = mapUsage(u)
  }
}

/** Events name their item by id; fall back to the output index for servers that omit it. */
function itemKey(ev: any): string {
  if (typeof ev?.item_id === "string" && ev.item_id) return ev.item_id
  return `#${typeof ev?.output_index === "number" ? ev.output_index : 0}`
}

export function mapUsage(u: any): Usage {
  const cached = u.input_tokens_details?.cached_tokens ?? 0
  const written = u.input_tokens_details?.cache_write_tokens ?? 0
  return {
    input: Math.max(0, (u.input_tokens ?? 0) - cached - written),
    output: u.output_tokens ?? 0,
    ...(typeof u.output_tokens_details?.reasoning_tokens === "number"
      ? { reasoning: u.output_tokens_details.reasoning_tokens }
      : {}),
    cacheRead: cached,
    cacheWrite: written,
  }
}
