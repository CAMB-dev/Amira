import type { Ai, Message, ModelErrorInfo, ModelInfo } from "@amira/ai"
import type {
  ApprovalRequest,
  AskOutcome,
  AskRequest,
  BackgroundJobHost,
  OutputStore,
  ProviderSettings,
  Settings,
  ToolApproval,
  TurnEndReason,
} from "@amira/api"
import type { CompactionOptions } from "../compaction.ts"
import type { ContextOptions, ContextView } from "../context.ts"
import type { EventBus } from "../event-bus.ts"
import type { FileRewind } from "../file-rewind.ts"
import type { InterceptorRegistry } from "../interceptors.ts"
import type { Permissions } from "../permissions/policy.ts"
import type { PromptSection } from "../prompt.ts"
import type { SessionStore } from "../session-store.ts"
import type { AgentTree } from "../subagents.ts"
import type { ToolRegistry } from "../tool-registry.ts"

export interface ApprovalDecision {
  approved: boolean
  /** Shown to the model when the call is denied. */
  reason?: string
  /** Who approved it, for the call's row (tool.execute.end `approval`). */
  by?: ToolApproval
  /** The user dismissed the question: the call is denied and the whole turn interrupted. */
  interrupt?: boolean
}

/** Decides a tool call that a tool.call.before interceptor asked about (D13, D14). */
export type Approver = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>

/** Answers the questions a session puts (ToolSession.askUser). */
export type Asker = (request: AskRequest, signal: AbortSignal) => Promise<AskOutcome>

export interface AgentOptions {
  ai: Ai
  model: ModelInfo
  cwd: string
  /** The whole system prompt as one "identity" section; `sections` takes precedence. */
  systemPrompt?: string
  /** The system prompt's named sections, in order (D43). */
  sections?: PromptSection[]
  /**
   * Where the conversation is persisted. Its id becomes the session id and, unless
   * `messages` is given, its current branch is restored.
   */
  session?: SessionStore
  fileRewind?: FileRewind
  fileRewindSettings?: Settings["fileRewind"]
  compaction?: CompactionOptions
  /** Context management: large outputs, repeated reads, aging (settings `context`). */
  context?: ContextOptions
  sessionId?: string
  parentSessionId?: string
  bus?: EventBus
  interceptors?: InterceptorRegistry
  tools?: ToolRegistry
  /** Per-provider and per-model editing tool choices, shared with sub-agents. */
  providerSettings?: Record<string, ProviderSettings>
  /** Upper bound on model calls per turn. Default 200. */
  maxSteps?: number
  maxTokens?: number
  /** How long tools get to stop after an abort before they are abandoned. Default 2000 ms. */
  abortGraceMs?: number
  /** Most tool calls running at once (D71). Default 8. */
  maxParallelTools?: number
  /**
   * After a turn carrying notices fails, they are sent again after each of these delays in
   * turn while the resends keep failing. Default 10 s, 30 s, 90 s.
   */
  noticeRetryMs?: number[]
  messages?: Message[]
  /**
   * Where `messages` come from (a fork of another agent): the history a compaction summary
   * among them stands for (Agent.compactedHistory), for a model that cannot read its server
   * checkpoint and needs a text summary written.
   */
  originals?: (summary: Message) => Message[] | undefined
  /**
   * How results among `messages` are sent (a fork of another agent: its contextViews), so the
   * child's requests carry what the parent's did.
   */
  views?: ReadonlyMap<Message, ContextView>
  /** The artifacts of the session this one was started from: output_read finds them too. */
  outputsParent?: OutputStore
  /** Sub-agent nesting depth; 0 (the default) for a top-level session. */
  depth?: number
  /** The agent tree this session belongs to: it spawns sub-agents and keeps the shared budget. */
  tree?: AgentTree
  /** The host's job implementation; the agent turns it into a caller-scoped view. */
  backgroundJobs?: BackgroundJobHost
  /**
   * Decides tool calls an interceptor asked about. Sub-agents get one from their tree that
   * asks the parent's model; without one such calls are denied.
   */
  approve?: Approver
  /**
   * The core permission policy (mode, command rules, protected paths), checked on every tool
   * call after the tool.call.before interceptors. Sub-agents share their parent's. Default: a
   * policy in "auto" mode without rules, which only asks before protected files change.
   */
  permissions?: Permissions
  /**
   * For a sub-agent: who answers the permission policy's questions, handed down from the
   * top-level session (Agent.permissionApprover) when `permissions` has no approver of its own.
   */
  permissionApprover?: Approver
  /**
   * Answers questions this session's tools put (ToolSession.askUser, the ask_user tool): the
   * user for a top-level session, the parent's model for sub-agents. Without one nobody answers.
   */
  ask?: Asker
  /**
   * Called instead of starting a turn when a notice arrives while the session is idle, for an
   * owner that decides when turns run (a persistent sub-agent waits for a place in its tree);
   * the owner starts it with wake(). Notices left when a turn ends then wait as well, instead
   * of starting the next turn by themselves.
   */
  onIdleNotice?: () => void
  /**
   * Asked after each batch of tool calls: true ends the turn there, as done, without another
   * model call (a sub-agent that handed back its structured result).
   */
  endTurn?: () => boolean
}

export interface TurnResult {
  reason: TurnEndReason
  steps: number
  error?: string
  /** A failed model request, read for the user (turn.end `failure`). */
  failure?: ModelErrorInfo
}

export interface PromptOptions {
  /** Id for the new turn, so a caller can report it before the turn runs. Default: a fresh one. */
  turnId?: string
}

export class AgentBusyError extends Error {}

/** A message sent during a manual compaction was dropped because the compaction was aborted. */
export class AgentAbortedError extends Error {}

export function newTurnId(): string {
  return `t_${crypto.randomUUID().slice(0, 8)}`
}

/** Default delays before held notices are sent again after failed turns. */
export const NOTICE_RETRY_MS = [10_000, 30_000, 90_000]
