import type { ImageBlock, Message, MessageDisplay, Usage } from "@amira/ai"
import type { AnyEvent } from "./events.ts"
import type { CompleteRequest, CompleteResult } from "./extension.ts"
import type { SpawnGroup, SpawnGroupOptions } from "./subagents.ts"
import type { SessionData, ToolDefinition, ToolResult } from "./tools.ts"
import type { AskAnswer, AskQuestion } from "./ui.ts"

/** Immutable, persisted identity and execution ceiling of an extension-owned conversation. */
export interface ConversationSpec {
  /** Stable within the host-assigned owner, not a filesystem path. */
  key: string
  name: string
  cwd: string
  /** provider/model; defaults to the host's current model at creation. */
  model?: string
  systemPrompt: string
  /** Required, fail-closed execution allowlist; reopening cannot widen it. */
  callableTools: string[]
  /** Absolute file-tool write ceiling; omitted is unbounded, [] denies file writes. Immutable. */
  writeRoots?: string[]
  /** Defaults to research (same cwd, no shell); inherit keeps ceilings with normal child execution. */
  descendants?: "research" | "inherit"
}

/** Executable capabilities are rebound on every reopen, never serialized. */
export interface ConversationRuntime {
  extraTools?: ToolDefinition[]
  /** Must obtain real human responses, never answers inferred by another model. */
  askUser: (
    questions: AskQuestion[],
    context: { sessionId: string; signal: AbortSignal },
  ) => Promise<AskAnswer[] | undefined>
}

/** Owner-scoped identity; neither form accepts a filesystem path. */
export type OwnedConversationRef = { id: string } | { key: string }

/** Serializable reported spend, not a guarantee of provider-invoice completeness. */
export interface AccountedUsage {
  usage: Usage
  /** Known priced subtotal, retained even when usage.cost is unavailable. */
  knownCostUsd: number
  /** False when reported accounting or price coverage is incomplete. */
  complete: boolean
}

/** Replace older snapshots by revision; signed corrections can reduce the subtotal. */
export interface ConversationUsageSnapshot {
  sessionId: string
  /** Accounting revision, independent of event sequence; survives reopening. */
  revision: number
  own: AccountedUsage
  /** Own plus attributed descendants, each counted exactly once. */
  total: AccountedUsage
  descendants: readonly {
    sessionId: string
    parentSessionId: string
    groupId?: string
    ephemeral?: boolean
    /** This descendant's own spend, not its subtree. */
    usage: AccountedUsage
  }[]
}

/** Inert, deeply immutable owner-authorized history and accounting. */
export interface OwnedConversationSnapshot {
  id: string
  key: string
  name: string
  cwd: string
  /** Reserved for durable archive support; currently always false. */
  archived: boolean
  history: readonly Message[]
  usage: ConversationUsageSnapshot
}

/**
 * Owner identity and lifetime are supplied by the host, not by the extension.
 * The public conversation interfaces, api.conversations capability and ToolSession.restricted
 * require a maintainer API_VERSION bump before release; the version file is not changed here.
 */
export interface OwnedConversations {
  /**
   * Inert creation/reopen, available during extension initialization.
   * Same owner instance reuses its handle; other writers conflict.
   */
  openOrCreate(spec: ConversationSpec, runtime: ConversationRuntime): Promise<OwnedConversation>
  /** Inert open, available during initialization; only this owner's ids, never file paths. */
  open(id: string, runtime: ConversationRuntime): Promise<OwnedConversation>
  /**
   * Inert read without model/runtime lookup, a writer lease, focus or filesystem repair.
   * Uses this manager's live handle when available, persisted evidence otherwise (which may
   * lag another writer and is then incomplete). Only genuinely missing records return undefined.
   */
  read(ref: OwnedConversationRef): Promise<OwnedConversationSnapshot | undefined>
}

export interface OwnedConversation {
  readonly id: string
  readonly key: string
  readonly name: string
  readonly cwd: string
  /**
   * Permanently bound to this conversation, including across main-session switches.
   * SessionData.append(): void is not a durable-write acknowledgement; disk failures are
   * reported asynchronously as extension.error. Evidence requiring a durable commit must
   * be committed to extension-controlled storage before answering askUser questions.
   */
  readonly data: SessionData
  /** Deeply immutable snapshot of the full current branch, including compacted originals. */
  history(): readonly Message[]
  /** Immutable cumulative accounting; budget.update/events.lost invalidate this snapshot. */
  usage(): ConversationUsageSnapshot
  status(): { state: "idle" | "working" | "blocked" | "stopped" | "error"; busy: boolean }
  /**
   * Conversation and ordinary descendant events only, never the main transcript bus.
   * Ephemeral descendants retain their private bus; use their ChildSession.events instead.
   * Each iterator subscribes immediately; subscribe before taking history/status snapshots.
   * No replay: deduplicate by seq and recover from events.lost using fresh snapshots.
   * Release ends all iterators.
   */
  readonly events: AsyncIterable<AnyEvent>
  /**
   * Resolves at the end of the accepted turn; concurrent sends are rejected, not queued.
   * Rejects during extension initialization. Start work from a command or session.start
   * handler after initialization; awaiting readiness inside the initializer deadlocks startup.
   */
  send(
    text: string,
    options?: {
      signal?: AbortSignal
      /** Image attachments included in the user message; text may be empty for image-only sends. */
      images?: ImageBlock[]
      /** Frontend display metadata preserved in history and events, never sent to the model. */
      display?: MessageDisplay
    },
  ): Promise<void>
  /**
   * Invokes a persisted callable tool while idle, with this conversation's cwd and policy.
   * Uses the model tool path (including approval), without a provider request or model messages.
   * Concurrent send/tool operations and initialization-time execution are rejected.
   * Tool denials, failures and cancellation return an error result. stop/release cancel and drain.
   */
  runTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<ToolResult>
  /**
   * Text-only side call using the persisted model, without tools, search or history injection.
   * All reported attempts are charged here, including retries/errors/aborts. No history turn
   * is added. Rejects initialization and overlap with send/runTool/complete; stop/release drain it.
   */
  complete(request: Omit<CompleteRequest, "model">): Promise<CompleteResult>
  /** Cancels work, questions and descendants; a later explicit send can continue. */
  stop(reason?: string): Promise<void>
  /** Stops, awaits cleanup and relinquishes the lease. Idempotent; history is retained. */
  release(): Promise<void>
  /**
   * Bound to this conversation and its persisted tool ceiling, never the current root.
   * Rejects during extension initialization; start work after initialization, as with send().
   */
  createGroup(options: SpawnGroupOptions): SpawnGroup
}
