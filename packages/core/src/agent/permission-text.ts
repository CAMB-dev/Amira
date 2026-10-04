// Owns permission-policy explanations for model results and approval dialogs.
import type { ApprovalPermission, PermissionMode } from "@amira/api"
import type { PermissionVerdict } from "../permissions/policy.ts"

/** What the model reads when the permission policy refuses a call: why, and what to do instead. */
export function refusedText(policy: PermissionVerdict): string {
  return [
    `Tool call blocked by the permission policy: ${policy.reason}.`,
    "Do not try to get around this with another tool or command. If this step is needed, ask the user: they can switch the permission mode or change the permission rules.",
  ].join("\n")
}

/** Added when a permission question was answered no, or nobody could answer it. */
export function askedText(policy: PermissionVerdict): string {
  return `The permission policy asked because ${policy.reason}. Do not try to get around this; if the step is needed, ask the user how to go on.`
}

/** What the approval dialog shows about the policy's question. */
export function approvalPermission(policy: PermissionVerdict, mode: PermissionMode): ApprovalPermission {
  const rule = policy.rule
  return {
    mode,
    cause: policy.cause ?? "mode",
    ...(rule
      ? {
          rule: {
            command: [...rule.command],
            decision: rule.decision,
            ...(rule.reason ? { reason: rule.reason } : {}),
            scope: rule.source.scope,
            file: rule.source.file,
          },
        }
      : {}),
  }
}
