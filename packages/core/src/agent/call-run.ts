import type { ToolCallBlock, ToolResultMessage } from "@amira/ai"
import type { ToolApproval, ToolDefinition } from "@amira/api"
import type { ApprovalTiming } from "./approvals.ts"

/**
 * One tool call of a batch. Tracked by the call itself, not its id: providers reuse ids across
 * steps (and some even within one reply), and each call still needs its own events and result.
 */
export interface CallRun {
  call: ToolCallBlock
  tool?: ToolDefinition
  writtenPaths?: string[]
  /** tool.execute.start has been emitted. */
  started: boolean
  /** The batch recorded this call's result; later updates and results from it are dropped. */
  finished: boolean
  /** The call has its result (tool.call.after may still be running on it). */
  returned?: boolean
  result?: ToolResultMessage
  /** Who approved it, when it needed approval. */
  approval?: ToolApproval
  /** Per-call approval timing, including a still-pending wait at abandonment. */
  approvalTiming?: ApprovalTiming
}
