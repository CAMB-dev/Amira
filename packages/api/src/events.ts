import type { AssistantMessage, Message, ModelRef, UserMessage } from "@amira/ai"
import type { ToolResult } from "./tools.ts"
import type { UiRequest } from "./ui.ts"

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
  /**
   * Announces a session. `startup` is a new session, `resume` continues a stored one,
   * `fork` branches from another, and `clear` starts over with an empty history.
   */
  "session.start": {
    reason: "startup" | "resume" | "fork" | "clear"
    cwd: string
    model: ModelRef
    /** Where the session is stored, once sessions are persisted. */
    sessionFile?: string
    /** Command line that resumes this session, e.g. ["amira", "--resume", "s_01"]. */
    resume?: string[]
  }
  /** Facts about the working directory. Sent after session.start and again whenever they change. */
  "workspace.changed": {
    cwd: string
    repoRoot?: string
    branch?: string
    /** Short commit hash, useful when HEAD is detached. */
    head?: string
    isWorktree?: boolean
  }
  "session.end": { reason: "exit" | "error" }
  "status.changed": { status: SessionStatus; reason?: string; pending?: number }
  "turn.start": { prompt: UserMessage }
  /** Always emitted once per turn, including after errors and aborts. */
  "turn.end": { reason: TurnEndReason; error?: string; steps: number }
  /** `contextWindow` is the model's context size in tokens, when known. */
  "message.start": { model: ModelRef; contextWindow?: number }
  "message.delta":
    | { kind: "text"; text: string }
    | { kind: "thinking"; text: string }
    | {
        kind: "toolCall"
        /** May change once while streaming; prefer `index` when present. */
        toolCallId: string
        /** Stable position of the call within the message. */
        index?: number
        name?: string
        argsDelta: string
      }
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
  /** Something visible changed outside the event stream (e.g. status bar state); frontends should redraw. */
  "ui.render": Record<string, never>
  "extension.error": { source: string; error: string }
  /** A slow subscriber's queue overflowed and events were dropped for it. */
  "events.lost": { dropped: number }
  /**
   * A message sent while a turn runs (D29): `queued` when accepted, `injected` when added to
   * the history before the next model call, `dropped` when the turn failed or was aborted
   * first, `promoted` when the turn finished before reaching it. Promoted messages start the
   * turn `nextTurnId` together, as one prompt holding their content in order.
   */
  "turn.steer":
    | { message: UserMessage; state: "queued" | "injected" | "dropped" }
    | { message: UserMessage; state: "promoted"; nextTurnId: string }
  /** A dialog waiting for an answer (D42); `source` is the extension that asked. */
  "ui.request": UiRequest & { requestId: string; source?: string }
  /** A dialog was answered or cancelled; frontends showing it should close it. */
  "ui.resolved": { requestId: string; cancelled: boolean; value?: string | boolean }
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
