import type { AssistantMessage, Message, ModelRef, Usage, UserMessage } from "@amira/ai"
import type { CommandOutputLevel } from "./commands.ts"
import type { Budget, ChildState, SpawnContext, SpawnGroupInfo, SubagentStatus } from "./subagents.ts"
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

/** How a notice reads: information, something that went well, or a problem. */
export type NoticeLevel = "info" | "success" | "warning" | "error"

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
    /**
     * The working tree has changes not committed yet (staged, unstaged or untracked files). It
     * is checked after turns that ran tools, so edits made outside Amira show from the next one.
     */
    dirty?: boolean
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
  /**
   * Something an extension tells the user (ExtensionAPI.notify), e.g. how a hook it ran went.
   * Frontends show it as a notice in the transcript; `source` is the extension.
   */
  "extension.notice": { source: string; text: string; level: NoticeLevel }
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
   * Notices (ToolSession.expectNotice, e.g. background sub-agents' results; their display has
   * an `origin`) go through the same states but are never dropped: an interrupted or failed
   * turn leaves them for the next one. Notices waiting together are injected as one message.
   */
  "turn.steer":
    | { message: UserMessage; state: "queued" | "injected" | "dropped" }
    | { message: UserMessage; state: "promoted"; nextTurnId: string }
  /** A dialog waiting for an answer (D42); `source` is the extension that asked. */
  "ui.request": UiRequest & { requestId: string; source?: string }
  /**
   * A dialog was answered or cancelled; frontends showing it should close it. `value` is left
   * out for forms, secret inputs and answers that are objects (ask answers, a confirm's free text).
   */
  "ui.resolved": { requestId: string; cancelled: boolean; value?: string | boolean }
  /**
   * Whether the user's frontend has focus, as far as it can tell: the TUI passes on what the
   * terminal reports (focus reporting), rpc clients send ui.focus. Sent with session id "host"
   * when it changes. A frontend that cannot tell never sends it, so until the first one
   * whether the user is looking is unknown. E.g. for notifying only a user who is away.
   */
  "ui.focus": { focused: boolean }
  /** Progress of a form action (a button such as "Fetch models") running on the host. */
  "ui.progress": { requestId: string; action: string; text: string }
  /** Text a slash command shows the user; `command` is its name, without the slash. */
  "command.output": { command: string; text: string; level: CommandOutputLevel }
  /**
   * A session started a sub-agent (D12). Sent with the parent's session id; the child's own
   * events carry `parentSessionId`. A `queued` child waits for a free slot (D63). `toolCallId`
   * is the parent's tool call that started it, when a tool did.
   */
  "subagent.start": {
    childSessionId: string
    role?: string
    title?: string
    toolCallId?: string
    prompt: string
    model: ModelRef
    depth: number
    cwd: string
    context: SpawnContext
    queued: boolean
    /** A long-lived child (SpawnOptions.persistent): it goes idle between turns. */
    persistent?: boolean
    /** The spawn group it counts against. */
    groupId?: string
  }
  /**
   * A sub-agent finished; sent with the parent's session id. `usage` is the child's alone.
   * `note` says why one that did not fail ended early (stopped, turn limit); `turns` is set
   * for children that ran more than one. `undelivered` counts messages sent to it that never
   * reached its model (SubagentResult.undelivered has them).
   */
  "subagent.end": {
    childSessionId: string
    toolCallId?: string
    status: SubagentStatus
    error?: string
    note?: string
    turns?: number
    undelivered?: number
    usage: Usage
    durationMs: number
  }
  /**
   * A persistent sub-agent changed state: `working` when a turn starts (or it waits for a
   * place to run one: `queued`), `idle` when a turn ended and it waits for a message. Its end
   * is subagent.end. Sent with the parent's session id; `turns` counts the turns started.
   */
  "subagent.state": {
    childSessionId: string
    state: Exclude<ChildState, "ended">
    turns: number
  }
  /** An extension created a spawn group (SpawnGroup); sent with the creating session's id. */
  "group.start": { group: SpawnGroupInfo }
  /** A spawn group's usage or its children's states changed. */
  "group.update": { group: SpawnGroupInfo }
  /** A spawn group ended: its owner ended it, or it went over its budget (`group.exceeded`). */
  "group.end": { group: SpawnGroupInfo }
  /** What the whole agent tree has used so far, sent after each model reply. */
  "budget.update": { tokens: number; costUsd?: number; limit?: Budget }
  /** The tree went over its budget: running sub-agents are aborted and no new ones start. */
  "budget.exceeded": { tokens: number; costUsd?: number; limit: Budget }
  /**
   * A turn carrying notices (background sub-agents' results) failed: in `delayMs` they are
   * sent again, starting turn number `attempt` of at most `attempts` retries (after the last
   * failing one they wait for the user's next message). A turn starting first (the user sent a
   * message) takes them along and cancels the retry. No retry follows an interrupt.
   */
  "notice.retry": { attempt: number; attempts: number; delayMs: number; error?: string }
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
   * Runs once a tool call has its result, before the result reaches the model or the history
   * and before tool.execute.end: for calls that ran, and for rejected ones (`rejected` says
   * why: "blocked", also for a call not approved or one that failed before running,
   * "unknownTool" or "invalidArgs"). Not once the turn was interrupted ("aborted" never gets
   * here): results from then on reach the model as they are. Only `result` may be modified,
   * e.g. to add a formatter's complaints or a language server's diagnostics for the file an
   * edit touched. block counts as pass. Failures pass, and the result stays as it was, as it
   * does when the modified result has no `content`.
   * `pending` lists the other calls of the same model reply that have no result yet (running
   * or still to start), so a handler can leave the work to the last of several edits: act on
   * the call whose `pending` has none of them. Do not wait inside a handler for pending calls:
   * they may not start before it returns.
   * Handlers that change files (formatters) should use a lower `priority` than ones that
   * read them (diagnostics), so the readers see the final contents.
   */
  "tool.call.after": {
    readonly toolCallId: string
    readonly name: string
    /** The arguments the tool ran with (after tool.call.before), or was called with if rejected first. */
    readonly args: Readonly<Record<string, unknown>>
    /** The calling session's working directory, which relative paths in `args` are relative to. */
    readonly cwd: string
    readonly rejected?: ToolRejection
    readonly pending: readonly { readonly toolCallId: string; readonly name: string }[]
    result: ToolResult
  }
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
