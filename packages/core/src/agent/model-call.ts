// Owns provider-stream translation, reasoning effort and compaction fallback reporting.
import type {
  Ai,
  AssistantMessage,
  Message,
  ModelError,
  ModelInfo,
  ModelRef,
  ReasoningEffort,
  ToolSpec,
  Usage,
} from "@amira/ai"
import { hasFastMode } from "@amira/ai"
import type { EventMap } from "@amira/api"
import { markAccountingIncomplete, usageSnapshot } from "../accounting-receipts.ts"
import { latchTransportFailure } from "./transport-failure.ts"
import type { AgentOptions } from "./types.ts"

/** Live and restored status interpret the reported field for this model's fast option. */
export function reportedSpeed(model: ModelInfo, usage: Usage | undefined): string | undefined {
  if (model.dialect === "anthropic-messages" && !(model.fast && model.fast.kind === "service-tier"))
    return usage?.speed
  return usage?.serviceTier ?? usage?.speed
}

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
  thinking?: ReasoningEffort
  fastMode?: boolean
  signal: AbortSignal
  emit: ModelCallEmit
  /** Book retried attempts separately from the final response's usage and reported speed. */
  recordAttempt?: (message: AssistantMessage) => void
}

/** The reasoning effort an agent asks for on a model; undefined sends none (the server default). */
export type ThinkingFor = (model: ModelInfo) => ReasoningEffort | undefined

/** What a session reports about effort: `thinking` only when it is sent to the model. */
export type ThinkingState = {
  supportsThinking: boolean
  thinkingLevel?: ReasoningEffort
  thinking?: ReasoningEffort
}

/**
 * An agent's reasoning effort, highest precedence first: the runtime override (/thinking, kept in
 * memory only), the explicit effort (a --thinking flag, or a sub-agent's inherited one, which never
 * falls back), the model's own setting, the top-level one.
 */
export class Thinking {
  /** An object tells "explicitly send none" apart from "no override". */
  #override: { level: ReasoningEffort | undefined } | undefined
  readonly #configured: ThinkingFor
  readonly #changed: (data: EventMap["thinking.changed"]) => void

  constructor(
    opts: Pick<AgentOptions, "thinking" | "defaultThinking" | "providerSettings" | "parentSessionId">,
    changed: (data: EventMap["thinking.changed"]) => void,
  ) {
    this.#configured = opts.parentSessionId
      ? () => opts.thinking
      : (model) =>
          opts.thinking ??
          opts.providerSettings?.[model.provider]?.models?.find((m) => m.id === model.id)?.thinking ??
          opts.defaultThinking
    this.#changed = changed
  }

  /** The effective effort for a model, even one that does not think (a request checks caps). */
  readonly for: ThinkingFor = (model) => (this.#override ? this.#override.level : this.#configured(model))

  /** What SessionInfo and the RPC state report for the current model. */
  state(model: ModelInfo): ThinkingState {
    const level = this.for(model)
    const supportsThinking = !!model.caps.thinking
    return {
      supportsThinking,
      ...(level ? { thinkingLevel: level } : {}),
      ...(supportsThinking && level ? { thinking: level } : {}),
    }
  }

  /** Sets the runtime override; undefined explicitly sends none, whatever is configured. */
  set(level: ReasoningEffort | undefined, model: ModelInfo): void {
    this.#override = { level }
    this.#changed(model.caps.thinking && level ? { thinking: level } : {})
  }

  /** Carries the override to the agent that replaces this one (rewind, resume, /clear, fork). */
  carryTo(next: Thinking): void {
    next.#override = this.#override
  }
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
  let backoff = false
  let dispatched = false
  let endedAttempt: AssistantMessage | undefined
  let latestUsage: Usage | undefined
  try {
    const stream = options.ai.stream(
      {
        model: options.model,
        systemPrompt: options.systemPrompt,
        messages: options.messages,
        tools: options.tools(),
        ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
        ...(options.fastMode && hasFastMode(options.model) ? { fastMode: true } : {}),
        ...(options.model.caps.thinking && options.thinking
          ? { reasoning: { effort: options.thinking } }
          : {}),
      },
      options.signal,
    )
    for await (const ev of stream) {
      // An abort before a new attempt opens repeats the receipt already booked below.
      if (
        backoff &&
        ev.type !== "retry" &&
        ev.type !== "fast.fallback" &&
        !(ev.type === "error" && ev.error.code === "aborted")
      )
        backoff = false
      if (retrying && ev.type !== "retry") {
        retrying = false
        options.emit("status.changed", { status: "working" })
      }
      if (
        (ev.type === "request.end" || ev.type === "done" || ev.type === "error") &&
        !(backoff && ev.type === "error" && ev.error.code === "aborted" && options.recordAttempt)
      )
        latestUsage = ev.message.usage ? usageSnapshot(ev.message.usage, latestUsage) : latestUsage
      switch (ev.type) {
        case "request.attempt":
          if (dispatched) {
            const previous = endedAttempt ?? final
            if (previous && latestUsage) options.recordAttempt?.({ ...previous, usage: latestUsage })
            endedAttempt = undefined
            final = undefined
            latestUsage = undefined
          }
          dispatched = true
          break
        case "fast.fallback":
          if (endedAttempt) options.recordAttempt?.(endedAttempt)
          endedAttempt = undefined
          latestUsage = undefined
          dispatched = false
          backoff = true
          options.emit("extension.notice", {
            source: "fast",
            text: "fast mode rate-limited; this request ran at standard speed — cache miss",
            level: "warning",
          })
          break
        case "request.start":
          options.emit("message.stream", { kind: "request", thinkingDisplay: ev.thinkingDisplay })
          break
        case "content.start":
          options.emit("message.stream", { kind: "contentStart", index: ev.index })
          break
        case "thinking.end":
          options.emit("message.stream", { kind: "thinkingEnd", index: ev.index })
          break
        case "request.end":
          endedAttempt = { ...ev.message, usage: latestUsage }
          options.emit("message.stream", {
            kind: "end",
            outputTokens: ev.message.usage?.outputReported === false ? undefined : ev.message.usage?.output,
          })
          break
        case "retry":
          if (endedAttempt) options.recordAttempt?.(endedAttempt)
          endedAttempt = undefined
          latestUsage = undefined
          dispatched = false
          backoff = true
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
          if (ev.text) options.emit("message.delta", { kind: "text", text: ev.text })
          break
        case "thinking.start":
          options.emit("message.stream", { kind: "thinkingStart", index: ev.index })
          break
        case "thinking.delta":
          if (ev.text) options.emit("message.delta", { kind: "thinking", text: ev.text })
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
          options.emit("message.stream", {
            kind: "end",
            outputTokens: ev.message.usage?.outputReported === false ? undefined : ev.message.usage?.output,
          })
          final = ev.message
          // A reply that ends well after the turn was interrupted is still an interrupted
          // one: a dialect may finish what it had already read without looking at the signal.
          if (options.signal.aborted) {
            aborted = true
            final = { ...ev.message, stopReason: "aborted" }
          }
          break
        case "error":
          options.emit("message.stream", {
            kind: "end",
            outputTokens: ev.message.usage?.outputReported === false ? undefined : ev.message.usage?.output,
          })
          final = backoff && options.recordAttempt ? { ...ev.message, usage: undefined } : ev.message
          if (ev.error.code === "aborted" || options.signal.aborted) aborted = true
          else {
            error = ev.error.message
            modelError = ev.error
            latchTransportFailure(options.signal, ev.error)
          }
          break
      }
    }
  } catch (err) {
    const usage = latestUsage ?? final?.usage ?? endedAttempt?.usage
    if (usage) markAccountingIncomplete(usage)
    if (options.signal.aborted) aborted = true
    else error = err instanceof Error ? err.message : String(err)
  }
  if (!final) {
    if (options.signal.aborted) aborted = true
    if (!error && !aborted) error = "the model stream ended without a final message"
    if (endedAttempt?.usage) markAccountingIncomplete(endedAttempt.usage)
  }

  // request.end may be the last receipt before an iterator throws, or a terminal
  // event may omit usage already reported for this same attempt. Retry/fallback
  // boundaries clear endedAttempt, so this never borrows a previous attempt's charge.
  const reply: AssistantMessage = final ?? {
    ...(endedAttempt ?? {
      role: "assistant",
      content: [],
      model: options.modelRef,
    }),
    stopReason: aborted ? "aborted" : "error",
  }
  // Cleanup receipts may correct usage without replacing the reply's text or stop reason.
  const message = latestUsage ? { ...reply, usage: latestUsage } : reply
  // An interrupted reply keeps its text but drops tool calls, which were never executed.
  if (aborted || error) message.content = message.content.filter((b) => b.type !== "toolCall")

  return {
    message,
    aborted,
    ...(error !== undefined ? { error } : {}),
    ...(modelError ? { modelError } : {}),
  }
}

/**
 * The reason a failed native compaction falls back to a text summary. A timeout (not a user
 * abort, which never gets here) also tells the user why, through `notice`.
 */
export function compactionFallback(
  r: { error: string; timedOut?: boolean },
  notice: (n: EventMap["extension.notice"]) => void,
): string {
  if (r.timedOut) {
    notice({
      source: "compaction",
      text: "Native compaction timed out. Writing a text summary instead.",
      level: "warning",
    })
  }
  return r.error
}
