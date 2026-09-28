import {
  type Ai,
  type AssistantMessage,
  invalidArgs,
  type Message,
  type ModelInfo,
  type ToolCallBlock,
  type ToolResultMessage,
  type UserMessage,
  userMessage,
} from "@amira/ai"
import type { EventMap, SessionStatus, ToolResult, TurnEndReason } from "@amira/api"
import { type EmitMeta, EventBus } from "./event-bus.ts"
import { InterceptorRegistry } from "./interceptors.ts"
import { ToolRegistry } from "./tool-registry.ts"

export interface AgentOptions {
  ai: Ai
  model: ModelInfo
  cwd: string
  systemPrompt: string
  sessionId?: string
  parentSessionId?: string
  bus?: EventBus
  interceptors?: InterceptorRegistry
  tools?: ToolRegistry
  /** Upper bound on model calls per turn. Default 200. */
  maxSteps?: number
  maxTokens?: number
  messages?: Message[]
}

export interface TurnResult {
  reason: TurnEndReason
  steps: number
  error?: string
}

export class AgentBusyError extends Error {}

/** One agent session: a conversation, a model and the loop that drives tool use. */
export class Agent {
  readonly sessionId: string
  readonly parentSessionId: string | undefined
  readonly bus: EventBus
  readonly interceptors: InterceptorRegistry
  readonly tools: ToolRegistry
  readonly cwd: string
  readonly messages: Message[]
  model: ModelInfo
  systemPrompt: string

  #ai: Ai
  #status: SessionStatus = "idle"
  #abort: AbortController | undefined
  #maxSteps: number
  #maxTokens: number | undefined
  #turnId: string | undefined

  constructor(opts: AgentOptions) {
    this.sessionId = opts.sessionId ?? `s_${crypto.randomUUID().slice(0, 8)}`
    this.parentSessionId = opts.parentSessionId
    this.bus = opts.bus ?? new EventBus()
    this.interceptors = opts.interceptors ?? new InterceptorRegistry()
    this.tools = opts.tools ?? new ToolRegistry()
    this.cwd = opts.cwd
    this.messages = opts.messages ?? []
    this.model = opts.model
    this.systemPrompt = opts.systemPrompt
    this.#ai = opts.ai
    this.#maxSteps = opts.maxSteps ?? 200
    this.#maxTokens = opts.maxTokens
  }

  get status(): SessionStatus {
    return this.#status
  }

  /** Aborts the running turn, if any. The turn still ends with a turn.end event. */
  abort(): void {
    this.#abort?.abort()
  }

  async prompt(input: string | UserMessage): Promise<TurnResult> {
    if (this.#abort) throw new AgentBusyError("a turn is already running")
    const abort = new AbortController()
    this.#abort = abort
    this.#turnId = `t_${crypto.randomUUID().slice(0, 8)}`
    const user = typeof input === "string" ? userMessage(input) : input

    let steps = 0
    let result: TurnResult = { reason: "done", steps: 0 }
    this.#emit("turn.start", { prompt: user })
    this.#setStatus("working")
    try {
      this.messages.push(user)
      while (true) {
        if (abort.signal.aborted) {
          result = { reason: "aborted", steps }
          break
        }
        if (steps >= this.#maxSteps) {
          result = { reason: "error", steps, error: `stopped after ${this.#maxSteps} model calls` }
          break
        }
        steps++
        const reply = await this.#callModel(abort.signal)
        if (reply.kind === "aborted") {
          result = { reason: "aborted", steps }
          break
        }
        if (reply.kind === "error") {
          result = { reason: "error", steps, error: reply.error }
          break
        }
        const calls = reply.message.content.filter((b): b is ToolCallBlock => b.type === "toolCall")
        if (calls.length === 0) {
          result = { reason: "done", steps }
          break
        }
        const aborted = await this.#runTools(calls, abort.signal)
        if (aborted) {
          result = { reason: "aborted", steps }
          break
        }
      }
    } catch (err) {
      result = { reason: "error", steps, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.#abort = undefined
      if (result.reason === "error") this.#setStatus("error", result.error)
      this.#emit("turn.end", {
        reason: result.reason,
        steps,
        ...(result.error !== undefined ? { error: result.error } : {}),
      })
      this.#setStatus("idle")
      this.#turnId = undefined
    }
    return result
  }

  async #callModel(
    signal: AbortSignal,
  ): Promise<
    { kind: "ok"; message: AssistantMessage } | { kind: "error"; error: string } | { kind: "aborted" }
  > {
    const ctx = await this.interceptors.run(
      "context.build",
      { systemPrompt: this.systemPrompt, messages: [...this.messages] },
      { sessionId: this.sessionId, signal },
    )
    const modelRef = { provider: this.model.provider, model: this.model.id }
    this.#emit("message.start", { model: modelRef })

    let final: AssistantMessage | undefined
    let error: string | undefined
    let aborted = false
    try {
      const stream = this.#ai.stream(
        {
          model: this.model,
          systemPrompt: ctx.value.systemPrompt,
          messages: ctx.value.messages,
          tools: this.tools.specs(),
          ...(this.#maxTokens ? { maxTokens: this.#maxTokens } : {}),
        },
        signal,
      )
      for await (const ev of stream) {
        switch (ev.type) {
          case "text.delta":
            this.#emit("message.delta", { kind: "text", text: ev.text })
            break
          case "thinking.delta":
            this.#emit("message.delta", { kind: "thinking", text: ev.text })
            break
          case "toolCall.delta":
            this.#emit("message.delta", {
              kind: "toolCall",
              toolCallId: ev.id,
              argsDelta: ev.argsDelta,
              ...(ev.name ? { name: ev.name } : {}),
            })
            break
          case "done":
            final = ev.message
            break
          case "error":
            final = ev.message
            if (ev.error.code === "aborted" || signal.aborted) aborted = true
            else error = ev.error.message
            break
        }
      }
    } catch (err) {
      if (signal.aborted) aborted = true
      else error = err instanceof Error ? err.message : String(err)
    }

    const message: AssistantMessage = final ?? {
      role: "assistant",
      content: [],
      model: modelRef,
      stopReason: aborted ? "aborted" : "error",
    }
    // An interrupted reply keeps its text but drops tool calls, which were never executed.
    if (aborted || error) message.content = message.content.filter((b) => b.type !== "toolCall")
    if (message.content.length) this.messages.push(message)
    this.#emit("message.end", { message })

    if (aborted) return { kind: "aborted" }
    if (error) return { kind: "error", error }
    return { kind: "ok", message }
  }

  /** Runs tool calls in order; consecutive parallel-safe tools run concurrently. Returns true if aborted. */
  async #runTools(calls: ToolCallBlock[], signal: AbortSignal): Promise<boolean> {
    const results: ToolResultMessage[] = []
    let i = 0
    while (i < calls.length) {
      if (signal.aborted) break
      const batch = [calls[i]!]
      if (this.tools.get(calls[i]!.name)?.concurrency === "parallel") {
        while (i + batch.length < calls.length) {
          const next = calls[i + batch.length]!
          if (this.tools.get(next.name)?.concurrency !== "parallel") break
          batch.push(next)
        }
      }
      results.push(...(await Promise.all(batch.map((c) => this.#runTool(c, signal)))))
      i += batch.length
    }
    // Every tool call needs a result, or the conversation is invalid for the next request.
    for (const c of calls.slice(results.length)) {
      results.push(toolError(c, "Aborted by the user before this tool ran."))
    }
    this.messages.push(...results)
    return signal.aborted
  }

  async #runTool(call: ToolCallBlock, signal: AbortSignal): Promise<ToolResultMessage> {
    const bad = invalidArgs(call.args)
    if (bad !== undefined) {
      return toolError(
        call,
        `Invalid JSON in tool arguments. Retry with valid JSON. Received: ${bad.slice(0, 500)}`,
      )
    }
    const tool = this.tools.get(call.name)
    if (!tool) {
      const names = this.tools
        .active()
        .map((t) => t.name)
        .join(", ")
      return toolError(call, `Unknown tool "${call.name}". Available tools: ${names}`)
    }
    const gate = await this.interceptors.run(
      "tool.call.before",
      { toolCallId: call.id, name: call.name, args: call.args },
      { sessionId: this.sessionId, signal },
    )
    if (gate.blocked) return toolError(call, `Tool call blocked: ${gate.reason}`)
    const args = gate.value.args

    const started = performance.now()
    this.#emit("tool.execute.start", { toolCallId: call.id, name: call.name, args })
    let result: ToolResult
    try {
      result = await tool.execute(args, {
        cwd: this.cwd,
        toolCallId: call.id,
        signal,
        update: (partial) =>
          this.#emit("tool.execute.update", { toolCallId: call.id, name: call.name, partial }),
      })
    } catch (err) {
      const msg = signal.aborted ? "Aborted by the user." : err instanceof Error ? err.message : String(err)
      result = { content: [{ type: "text", text: msg }], isError: true }
    }
    this.#emit("tool.execute.end", {
      toolCallId: call.id,
      name: call.name,
      result,
      durationMs: Math.round(performance.now() - started),
    })
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: result.content,
      isError: result.isError ?? false,
    }
  }

  #setStatus(status: SessionStatus, reason?: string) {
    if (status === this.#status && reason === undefined) return
    this.#status = status
    this.#emit("status.changed", { status, ...(reason !== undefined ? { reason } : {}) })
  }

  #emit<K extends keyof EventMap>(type: K, data: EventMap[K]) {
    const meta: EmitMeta = { sessionId: this.sessionId }
    if (this.parentSessionId) meta.parentSessionId = this.parentSessionId
    if (this.#turnId) meta.turnId = this.#turnId
    this.bus.emit(type, data, meta)
  }
}

function toolError(call: ToolCallBlock, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError: true,
  }
}
