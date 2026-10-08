import { NATIVE_WEB_SEARCH, serverToolSnapshot } from "../server-tools.ts"
import { parseToolArgs } from "../tool-args.ts"
import type {
  AssistantMessage,
  ModelError,
  ModelRef,
  ServerToolBlock,
  StopReason,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
} from "../types.ts"
import { emptyUsage } from "../types.ts"
import { anthropicError } from "./anthropic-errors.ts"
import { ANTHROPIC_DIALECT } from "./anthropic-messages.ts"
import { searchCitations, searchResult } from "./anthropic-web-search.ts"
import { madeUpIdPrefix } from "./tool-results.ts"

type ErrorEvent = Extract<StreamEvent, { type: "error" }>

type Open =
  | { kind: "text"; block: TextBlock; raw: Record<string, any> }
  | { kind: "thinking"; block: ThinkingBlock; closed: boolean }
  | { kind: "tool"; block: ToolCallBlock; index: number; json: string; initial: unknown; closed: boolean }
  | { kind: "search"; block: ServerToolBlock; raw: Record<string, any>; json: string; closed: boolean }

/** Builds the assistant message from Messages API stream events and emits the matching deltas. */
export class MessagesAccumulator {
  readonly message: AssistantMessage
  readonly #blocks = new Map<number, Open>()
  #tools = 0
  readonly #idPrefix = madeUpIdPrefix()
  #stop: string | undefined
  #stopDetails: unknown
  #finished = false

  constructor(model: ModelRef) {
    this.message = { role: "assistant", content: [], model }
  }

  /** True once the stream said how the message ended. */
  get finished(): boolean {
    return this.#finished || this.#stop !== undefined
  }

  /** Applies one event. An `error` event from the server yields the final error event. */
  *apply(ev: any): Generator<StreamEvent> {
    switch (ev?.type) {
      case "message_start":
        this.#usage(ev.message?.usage)
        return
      case "content_block_start":
        yield* this.#start(ev.index, ev.content_block)
        return
      case "content_block_delta":
        yield* this.#delta(ev.index, ev.delta)
        return
      case "content_block_stop": {
        const open = this.#blocks.get(ev.index)
        if (open?.kind === "thinking" && !open.closed) {
          open.closed = true
          yield { type: "thinking.end", index: ev.index }
        }
        this.#close(open)
        return
      }
      case "message_delta":
        this.#usage(ev.usage)
        if (typeof ev.delta?.stop_reason === "string") this.#stop = ev.delta.stop_reason
        this.#stopDetails = ev.delta?.stop_details ?? this.#stopDetails
        return
      case "message_stop":
        this.#finished = true
        return
      case "error": {
        const { error, retryable } = anthropicError(ev)
        yield this.fail(error, retryable)
      }
    }
  }

  *#start(index: number, cb: any): Generator<StreamEvent> {
    yield { type: "content.start", index }
    if (cb?.type === "text") {
      const block: TextBlock = { type: "text", text: "" }
      this.message.content.push(block)
      const raw = { ...cb, text: "" }
      this.#blocks.set(index, { kind: "text", block, raw })
      yield* this.#delta(index, { type: "text_delta", text: cb.text })
      searchCitations(block, raw)
    } else if (cb?.type === "thinking") {
      const block: ThinkingBlock = { type: "thinking", text: "" }
      this.message.content.push(block)
      this.#blocks.set(index, { kind: "thinking", block, closed: false })
      yield { type: "thinking.start", index }
      if (cb.thinking) yield* this.#delta(index, { type: "thinking_delta", thinking: cb.thinking })
      this.#sign(block, cb.signature)
    } else if (cb?.type === "redacted_thinking") {
      const block: ThinkingBlock = { type: "thinking", text: "", redacted: true }
      this.#sign(block, cb.data)
      this.message.content.push(block)
      this.#blocks.set(index, { kind: "thinking", block, closed: false })
      yield { type: "thinking.start", index }
    } else if (cb?.type === "server_tool_use" && cb.name === NATIVE_WEB_SEARCH) {
      const block: ServerToolBlock = {
        type: "serverTool",
        id: String(cb.id ?? `search_${index}`),
        name: NATIVE_WEB_SEARCH,
        input: {},
        status: "running",
      }
      this.message.content.push(block)
      this.#blocks.set(index, { kind: "search", block, raw: { ...cb }, json: "", closed: false })
      yield serverToolSnapshot(block)
    } else if (cb?.type === "web_search_tool_result") {
      const open = [...this.#blocks.values()].find(
        (b) => b.kind === "search" && b.block.id === cb.tool_use_id,
      )
      if (open?.kind !== "search") return
      this.#close(open)
      const after = this.message.content.length - this.message.content.indexOf(open.block) - 1
      yield searchResult(open.block, open.raw, cb, after, index)
    } else if (cb?.type === "tool_use") {
      const block: ToolCallBlock = {
        type: "toolCall",
        id: String(cb.id ?? ""),
        name: String(cb.name ?? ""),
        args: {},
      }
      if (!block.id) block.id = `${this.#idPrefix}${this.#tools}`
      const open = {
        kind: "tool" as const,
        block,
        index: this.#tools++,
        json: "",
        initial: cb.input,
        closed: false,
      }
      this.message.content.push(block)
      this.#blocks.set(index, open)
      yield { type: "toolCall.delta", id: block.id, index: open.index, name: block.name, argsDelta: "" }
    }
  }

  *#delta(index: number, d: any): Generator<StreamEvent> {
    const open = this.#blocks.get(index)
    if (!open) return
    if (open.kind === "text" && d?.type === "text_delta" && typeof d.text === "string" && d.text) {
      open.block.text += d.text
      open.raw.text = open.block.text
      searchCitations(open.block, open.raw)
      yield { type: "text.delta", text: d.text }
    } else if (open.kind === "text" && d?.type === "citations_delta" && d.citation) {
      open.raw.citations = [...(Array.isArray(open.raw.citations) ? open.raw.citations : []), d.citation]
      searchCitations(open.block, open.raw)
    } else if (
      open.kind === "search" &&
      d?.type === "input_json_delta" &&
      typeof d.partial_json === "string"
    ) {
      open.json += d.partial_json
    } else if (open.kind === "thinking" && d?.type === "thinking_delta") {
      if (typeof d.thinking !== "string") return
      open.block.text += d.thinking
      yield { type: "thinking.delta", text: d.thinking }
    } else if (open.kind === "thinking" && d?.type === "signature_delta") {
      this.#sign(open.block, (open.block.signature?.value ?? "") + (d.signature ?? ""))
    } else if (open.kind === "tool" && d?.type === "input_json_delta" && typeof d.partial_json === "string") {
      open.json += d.partial_json
      if (d.partial_json) {
        yield {
          type: "toolCall.delta",
          id: open.block.id,
          index: open.index,
          name: open.block.name,
          argsDelta: d.partial_json,
        }
      }
    }
  }

  #sign(block: ThinkingBlock, value: unknown) {
    if (typeof value === "string" && value) block.signature = { dialect: ANTHROPIC_DIALECT, value }
  }

  #close(open: Open | undefined) {
    if (open?.kind === "search") {
      if (open.closed) return
      open.closed = true
      open.block.input = open.json ? parseToolArgs(open.json) : (open.raw.input ?? {})
      open.raw.input = open.block.input
      return
    }
    if (open?.kind !== "tool" || open.closed) return
    open.closed = true
    const initial = open.initial
    const hasInitial = initial && typeof initial === "object" && Object.keys(initial).length > 0
    open.block.args =
      !open.json && hasInitial ? (initial as Record<string, unknown>) : parseToolArgs(open.json)
  }

  #usage(u: any) {
    if (!u || typeof u !== "object") return
    this.message.usage ??= emptyUsage()
    const usage = this.message.usage
    const pick = (v: unknown, prev: number) => (typeof v === "number" ? v : prev)
    usage.input = pick(u.input_tokens, usage.input)
    usage.output = pick(u.output_tokens, usage.output)
    const thinking = u.output_tokens_details?.thinking_tokens
    if (typeof thinking === "number") usage.reasoning = thinking
    usage.cacheRead = pick(u.cache_read_input_tokens, usage.cacheRead)
    usage.cacheWrite = pick(u.cache_creation_input_tokens, usage.cacheWrite)
    const searches = u.server_tool_use?.web_search_requests
    if (typeof searches === "number" && Number.isInteger(searches) && searches >= 0)
      usage.webSearchRequests = searches
  }

  #closeAll() {
    for (const open of this.#blocks.values()) if (open.kind !== "search") this.#close(open)
  }

  fail(error: ModelError, retryable: boolean): ErrorEvent {
    this.#closeAll()
    this.message.stopReason = error.code === "aborted" ? "aborted" : "error"
    return { type: "error", error, retryable, message: this.message }
  }

  /** Closes the message: a done event, or an error when the model refused. */
  end(): StreamEvent {
    this.#closeAll()
    if (this.#stop === "refusal") {
      const message = `the model refused to answer (stop_reason: refusal)${refusalDetails(this.#stopDetails)}`
      return this.fail({ message, code: "refusal" }, false)
    }
    // A search still without its result runs when the call goes back unchanged: after a
    // pause, or alongside client tool calls. Anywhere else the API would reject it alone.
    if (this.#stop === "pause_turn" || this.#stop === "tool_use") {
      for (const open of this.#blocks.values()) {
        if (open.kind !== "search" || open.block.signature) continue
        this.#close(open)
        open.block.signature = { dialect: ANTHROPIC_DIALECT, value: JSON.stringify({ call: open.raw }) }
      }
    }
    const stop = mapStop(this.#stop)
    const hasCalls = this.message.content.some((b) => b.type === "toolCall")
    this.message.stopReason = stop === "end" && hasCalls ? "toolUse" : stop
    return { type: "done", message: this.message }
  }
}

/** `stop_details` of a refusal, as ": category: explanation", or nothing. */
function refusalDetails(details: any): string {
  const parts = [details?.category, details?.explanation].filter((p) => typeof p === "string" && p)
  return parts.length ? `: ${parts.join(": ")}` : ""
}

function mapStop(reason: string | undefined): StopReason {
  switch (reason) {
    case "tool_use":
      return "toolUse"
    case "max_tokens":
    case "model_context_window_exceeded":
      return "maxTokens"
    default:
      return "end"
  }
}
