import type { AssistantMessage, Message, ModelRef, Usage, UserMessage } from "@amira/ai"
import type { CommandOutputLevel } from "./commands.ts"
import type { Budget, SpawnContext, SubagentStatus } from "./subagents.ts"
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
  /** The session switched models; later turns use `to`. */
  "model.changed": { from: ModelRef; to: ModelRef }
  /**
   * Older history is being summarized. `replacing` counts the messages that will be replaced,
   * `kept` those that stay verbatim; `tokens` is the context size that triggered it, when known.
   */
  "compact.start": { reason: "threshold" | "manual"; replacing: number; kept: number; tokens?: number }
  "compact.end": { summary: string; replaced: number; kept: number }
  /**
   * Compaction did not happen; the conversation continues uncompacted. `blocked` means a
   * compact.before interceptor cancelled it on purpose (`error` is its reason); no
   * compact.start precedes it then.
   */
  "compact.failed": { error: string; blocked?: boolean }
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
  /**
   * A dialog was answered or cancelled; frontends showing it should close it. `value` is left
   * out for forms and secret inputs.
   */
  "ui.resolved": { requestId: string; cancelled: boolean; value?: string | boolean }
  /** Progress of a form action (a button such as "Fetch models") running on the host. */
  "ui.progress": { requestId: string; action: string; text: string }
  /** Text a slash command shows the user; `command` is its name, without the slash. */
  "command.output": { command: string; text: string; level: CommandOutputLevel }
  /**
   * A session started a sub-agent (D12). Sent with the parent's session id; the child's own
   * events carry `parentSessionId`. A `queued` child waits for a free slot (D63).
   */
  "subagent.start": {
    childSessionId: string
    role?: string
    prompt: string
    model: ModelRef
    depth: number
    cwd: string
    context: SpawnContext
    queued: boolean
  }
  /** A sub-agent finished; sent with the parent's session id. `usage` is the child's alone. */
  "subagent.end": {
    childSessionId: string
    status: SubagentStatus
    error?: string
    usage: Usage
    durationMs: number
  }
  /** What the whole agent tree has used so far, sent after each model reply. */
  "budget.update": { tokens: number; costUsd?: number; limit?: Budget }
  /** The tree went over its budget: running sub-agents are aborted and no new ones start. */
  "budget.exceeded": { tokens: number; costUsd?: number; limit: Budget }
}

/** A named part of the system prompt (D43). */
export interface SystemSection {
  name: string
  text: string
}

/**
 * For system.build handlers: replaces the named section's text, or adds the section before
 * "role" (or last) when the prompt has none of that name. Returns a new list.
 */
export function withSection(sections: SystemSection[], name: string, text: string): SystemSection[] {
  if (sections.some((s) => s.name === name))
    return sections.map((s) => (s.name === name ? { name, text } : s))
  const role = sections.findIndex((s) => s.name === "role")
  const out = [...sections]
  out.splice(role === -1 ? out.length : role, 0, { name, text })
  return out
}

/**
 * `ask` (tool.call.before only; elsewhere it counts as pass) wants the call approved first:
 * by the user for a top-level session, by the parent's model for a sub-agent (D14). Later
 * handlers still run, and a block from one of them wins.
 */
export type Intercept<T> =
  | { action: "pass" }
  | { action: "modify"; value: T }
  | { action: "block"; reason: string }
  | { action: "ask"; reason: string }

/** Decision points where the core awaits an ordered pipeline of handlers. */
export interface InterceptorMap {
  /** Runs before every model call. block ends the turn with an error. */
  "context.build": { systemPrompt: string; messages: Message[] }
  /** Runs before a tool executes. Only `args` may be modified; block returns an error result to the model. */
  "tool.call.before": { readonly toolCallId: string; readonly name: string; args: Record<string, unknown> }
  /**
   * Runs before every model call, ahead of context.build, with the system prompt's sections
   * in order ("identity", "environment", "project", "skills", "deferred-tools", "role").
   * modify may edit, add or remove sections. Failures pass.
   */
  "system.build": { sections: SystemSection[] }
  /**
   * Runs before compaction summarizes `messages` (the older history; `kept` stays verbatim).
   * modify may supply `summary` to skip the default model summary; block cancels this
   * compaction. Failures pass, and the default summary is used.
   */
  "compact.before": { readonly messages: Message[]; readonly kept: Message[]; summary?: string }
}

export interface InterceptorOptions {
  /** Lower runs first; ties run in registration order. */
  priority?: number
  /** Defaults to the configured interceptor timeout (5000 ms). */
  timeoutMs?: number
}
