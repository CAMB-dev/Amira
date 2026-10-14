import type { ApprovalRequest } from "@amira/api"
import type { Agent, ApprovalDecision } from "../agent.ts"

/** Restricted sessions cannot replace a host approval request with a model consultation. */
export function approveWithHost(
  parent: Agent,
  request: ApprovalRequest,
  signal: AbortSignal,
): Promise<ApprovalDecision> {
  return (
    parent.permissionApprover?.(request, signal) ??
    Promise.resolve({
      approved: false,
      reason: "it needs approval and nobody can approve it here",
    })
  )
}
