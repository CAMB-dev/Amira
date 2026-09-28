import type { AssistantMessage, Message, ModelRef, UserMessage } from "@amira/ai"
import type { ToolResult } from "./tools.ts"

/** Envelope shared by every event, whether seen by the TUI, headless clients or extensions. */
export interface EventEnvelope<K extends keyof EventMap = keyof EventMap> {
  /** Monotonic within the process. */
  seq: number
  ts: number
  sessionId: string
  parentSessionId?: string
  turnId?: string
  type: K
  data: EventMap[K]
}

export type AnyEvent = { [K in keyof EventMap]: EventEnvelope<K> }[keyof EventMap]

export type SessionStatus = "idle" | "working" | "blocked" | "error"

export type TurnEndReason = "done" | "error" | "aborted"

/** Why a tool call produced an error result without its tool running to completion. */
export type ToolRejection = "blocked" | "unknownTool" | "invalidArgs" | "aborted"

/** Read-only events. Emitting never waits for subscribers. New events are only ever added. */
export interface EventMap {
  "session.start": {
    reason: "startup" | "resume" | "fork" | "clear"
    cwd: string
    model: ModelRef
    sessionFile?: string
    resume?: string[]
    repoRoot?: string
    branch?: string
    isWorktree?: boolean
  }
  "session.end": { reason: "exit" | "error" }
  "status.changed": { status: SessionStatus; reason?: string; pending?: number }
  "turn.start": { prompt: UserMessage }
  /** Always emitted once per turn, including after errors and aborts. */
  "turn.end": { reason: TurnEndReason; error?: string; steps: number }
  "message.start": { model: ModelRef }
  "message.delta":
    | { kind: "text"; text: string }
    | { kind: "thinking"; text: string }
    | { kind: "toolCall"; toolCallId: string; name?: string; argsDelta: string }
  "message.end": { message: AssistantMessage }
  "tool.execute.start": { toolCallId: string; name: string; args: Record<string, unknown> }
  "tool.execute.update": { toolCallId: string; name: string; partial: ToolResult }
  /**
   * Emitted for every tool call, including ones that never ran; `rejected` says why.
   * Always paired with a preceding tool.execute.start.
   */
  "tool.execute.end": {
    toolCallId: string
    name: string
    result: ToolResult
    durationMs: number
    rejected?: ToolRejection
  }
  "extension.loaded": { source: string }
  "extension.error": { source: string; error: string }
  /** A slow subscriber's queue overflowed and events were dropped for it. */
  "events.lost": { dropped: number }
}

export type Intercept<T> =
  | { action: "pass" }
  | { action: "modify"; value: T }
  | { action: "block"; reason: string }

/** Decision points where the core awaits an ordered pipeline of handlers. */
export interface InterceptorMap {
  /** Runs before every model call. block ends the turn with an error. */
  "context.build": { systemPrompt: string; messages: Message[] }
  /** Runs before a tool executes. Only `args` may be modified; block returns an error result to the model. */
  "tool.call.before": { readonly toolCallId: string; readonly name: string; args: Record<string, unknown> }
}

export interface InterceptorOptions {
  /** Lower runs first; ties run in registration order. */
  priority?: number
  /** Defaults to the configured interceptor timeout (5000 ms). */
  timeoutMs?: number
}
