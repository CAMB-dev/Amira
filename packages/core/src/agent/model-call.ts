import type { Ai, AssistantMessage, Message, ModelError, ModelInfo, ModelRef, ToolSpec } from "@amira/ai"
import type { EventMap } from "@amira/api"

export type ModelCallEmit = <K extends keyof EventMap>(type: K, data: EventMap[K]) => void

export interface ModelCallOptions {
  ai: Ai
  model: ModelInfo
  modelRef: ModelRef
  systemPrompt: string
  messages: Message[]
  /** Read inside the stream's try, so a failure becomes this call's error as before. */
  tools: () => ToolSpec[]
  maxTokens?: number
  signal: AbortSignal
  emit: ModelCallEmit
}

export interface ModelCallResult {
  message: AssistantMessage
  aborted: boolean
  error?: string
  modelError?: ModelError
}

/** Performs one provider stream, translates it into Agent events, and classifies the call. */
export async function modelCall(options: ModelCallOptions): Promise<ModelCallResult> {
  let final: AssistantMessage | undefined
  let error: string | undefined
  let modelError: ModelError | undefined
  let aborted = false
  let retrying = false
  try {
    const stream = options.ai.stream(
      {
        model: options.model,
        systemPrompt: options.systemPrompt,
        messages: options.messages,
        tools: options.tools(),
        ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
      },
      options.signal,
    )
    for await (const ev of stream) {
      if (retrying && ev.type !== "retry") {
        retrying = false
        options.emit("status.changed", { status: "working" })
      }
      switch (ev.type) {
        case "retry":
          retrying = true
          options.emit("model.retry", {
            attempt: ev.attempt,
            maxRetries: ev.maxRetries,
            delayMs: ev.delayMs,
            error: ev.error.message,
            kind: ev.error.kind ?? "other",
            ...(ev.error.status !== undefined ? { status: ev.error.status } : {}),
          })
          options.emit("status.changed", {
            status: "working",
            reason: `retrying (${ev.attempt}/${ev.maxRetries})`,
          })
          break
        case "text.delta":
          options.emit("message.delta", { kind: "text", text: ev.text })
          break
        case "thinking.delta":
          options.emit("message.delta", { kind: "thinking", text: ev.text })
          break
        case "toolCall.delta":
          options.emit("message.delta", {
            kind: "toolCall",
            toolCallId: ev.id,
            argsDelta: ev.argsDelta,
            ...(ev.index !== undefined ? { index: ev.index } : {}),
            ...(ev.name ? { name: ev.name } : {}),
          })
          break
        // The provider runs it: shown as it goes, never executed here.
        case "serverTool":
          options.emit("message.delta", { kind: "serverTool", block: ev.block })
          break
        case "done":
          final = ev.message
          // A reply that ends well after the turn was interrupted is still an interrupted
          // one: a dialect may finish what it had already read without looking at the signal.
          if (options.signal.aborted) {
            aborted = true
            final = { ...ev.message, stopReason: "aborted" }
          }
          break
        case "error":
          final = ev.message
          if (ev.error.code === "aborted" || options.signal.aborted) aborted = true
          else {
            error = ev.error.message
            modelError = ev.error
          }
          break
      }
    }
  } catch (err) {
    if (options.signal.aborted) aborted = true
    else error = err instanceof Error ? err.message : String(err)
  }
  if (!final && !error && !aborted) error = "the model stream ended without a final message"

  const message: AssistantMessage = final ?? {
    role: "assistant",
    content: [],
    model: options.modelRef,
    stopReason: aborted ? "aborted" : "error",
  }
  // An interrupted reply keeps its text but drops tool calls, which were never executed.
  if (aborted || error) message.content = message.content.filter((b) => b.type !== "toolCall")

  return {
    message,
    aborted,
    ...(error !== undefined ? { error } : {}),
    ...(modelError ? { modelError } : {}),
  }
}
