import { parseToolArgs } from "../tool-args.ts"
import type {
  AssistantMessage,
  ModelError,
  ModelRef,
  StopReason,
  StreamEvent,
  TextBlock,
  Usage,
} from "../types.ts"
import { emptyUsage } from "../types.ts"
import { ToolCallAssembler } from "./openai-chat-tool-calls.ts"

type ErrorEvent = Extract<StreamEvent, { type: "error" }>

/** Builds the assistant message from chat completion chunks and emits the matching deltas. */
export class ChatAccumulator {
  readonly message: AssistantMessage
  #text: TextBlock | undefined
  #thinking: { type: "thinking"; text: string } | undefined
  readonly #calls = new ToolCallAssembler()
  #finish: string | undefined

  constructor(model: ModelRef) {
    this.message = { role: "assistant", content: [], model, usage: emptyUsage() }
  }

  *apply(chunk: any): Generator<StreamEvent> {
    if (chunk.usage) this.message.usage = mapUsage(chunk.usage)
    const choice = chunk.choices?.[0]
    if (!choice) return
    const delta = choice.delta ?? {}
    const reasoning: unknown = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === "string" && reasoning) {
      if (!this.#thinking) {
        this.#thinking = { type: "thinking", text: "" }
        this.message.content.push(this.#thinking)
      }
      this.#thinking.text += reasoning
      yield { type: "thinking.delta", text: reasoning }
    }
    if (typeof delta.content === "string" && delta.content) {
      if (!this.#text) {
        this.#text = { type: "text", text: "" }
        this.message.content.push(this.#text)
      }
      this.#text.text += delta.content
      yield { type: "text.delta", text: delta.content }
    }
    yield* this.#calls.apply(delta.tool_calls)
    if (choice.finish_reason) this.#finish = choice.finish_reason
  }

  fail(error: ModelError, retryable: boolean): ErrorEvent {
    this.message.stopReason = error.code === "aborted" ? "aborted" : "error"
    return { type: "error", error, retryable, message: this.message }
  }

  /** Closes the message: a done event, or an error when the provider filtered the output. */
  end(): StreamEvent {
    const toolBlocks = this.#calls.calls.map((c) => ({
      type: "toolCall" as const,
      id: c.id,
      name: c.name,
      args: parseToolArgs(c.args),
    }))
    this.message.content.push(...toolBlocks)
    const stop = mapFinish(this.#finish)
    if (stop === "error") {
      return this.fail(
        {
          message: "the provider filtered the output (finish_reason: content_filter)",
          code: "content_filter",
        },
        false,
      )
    }
    this.message.stopReason = stop === "end" && toolBlocks.length ? "toolUse" : stop
    return { type: "done", message: this.message }
  }
}

function mapFinish(reason: string | undefined): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "toolUse"
    case "length":
      return "maxTokens"
    case "content_filter":
      return "error"
    default:
      return "end"
  }
}

function mapUsage(u: any): Usage {
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0
  return {
    input: Math.max(0, (u.prompt_tokens ?? 0) - cached),
    output: u.completion_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
  }
}
