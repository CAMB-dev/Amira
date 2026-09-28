import type { ModelRef, Usage } from "@amira/ai"
import type { AnyEvent } from "./events.ts"

/** What a sub-agent starts with (D12): only its task, or the parent's conversation so far. */
export type SpawnContext = "fresh" | "fork"

export interface SpawnOptions {
  /** Role name, recorded with the child and shown by frontends. */
  role?: string
  /** The task. With `fork` it follows the parent's history as a new user message. */
  prompt: string
  /** "provider/model". Default: the parent's current model. */
  model?: string
  /** Default "fresh". */
  context?: SpawnContext
  /** Working directory, e.g. a worktree. Default: the parent's. */
  cwd?: string
  /** Names of the tools the child may use. Default: every tool the parent has. */
  tools?: string[]
  /** Tools the child may not use, e.g. the one that spawns sub-agents once it is deep enough. */
  excludeTools?: string[]
  /** Instructions for the child, placed in its system prompt's "role" section. */
  systemPrompt?: string
}

export type SubagentStatus = "done" | "error" | "aborted"

export interface SubagentResult {
  sessionId: string
  status: SubagentStatus
  /** The child's final answer: the text of its last reply. */
  text: string
  error?: string
  /** Tokens and cost of this child alone, its own children excluded. */
  usage: Usage
  steps: number
  durationMs: number
}

/** A running (or queued) sub-agent. */
export interface ChildSession {
  readonly id: string
  readonly parentSessionId: string
  /** 1 for a child of a top-level session, 2 for a grandchild. */
  readonly depth: number
  readonly model: ModelRef
  readonly cwd: string
  /**
   * The events of this child and its descendants, ending with its subagent.end. Each
   * iteration subscribes when it starts, so start iterating right after spawn to miss nothing;
   * iterating a child that already ended yields nothing.
   */
  readonly events: AsyncIterable<AnyEvent>
  /** Settles once the child's turn ended, however it ended. Never rejects. */
  result(): Promise<SubagentResult>
  /** Stops the child (or takes it out of the queue); its result says aborted. */
  abort(reason?: string): void
}

/** A limit shared by a whole agent tree (D15, D37). Unset fields are unlimited. */
export interface Budget {
  /** All tokens: input, output and cache reads and writes. */
  tokens?: number
  costUsd?: number
}

/** A tool call a tool.call.before interceptor wants approved before it runs (D13, D14). */
export interface ApprovalRequest {
  sessionId: string
  toolCallId: string
  name: string
  args: Record<string, unknown>
  /** Why the interceptor asked. */
  reason: string
}
