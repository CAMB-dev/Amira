import { registerAgentHostHooks } from "@amira/core/internal"
import { scopedBackgroundJobs } from "./agent-background-jobs.ts"
import { recordConversationUsage } from "./conversation-usage.ts"
import { holdsAgentSession, registerAgentSession, unregisterAgentSession } from "./session-routing.ts"
import { bindGroupSignal } from "./subagents/child.ts"
import { scopeAdmission } from "./subagents/lifecycle.ts"

let registered = false

/** Wires `@amira/host` runtime seams into `@amira/core`'s Agent loop (idempotent). */
export function ensureAgentHostHooks(): void {
  if (registered) return
  registered = true
  registerAgentHostHooks({
    registerSession: registerAgentSession,
    unregisterSession: unregisterAgentSession,
    holdsSession: holdsAgentSession,
    recordStandaloneUsage: (agent, usage) => recordConversationUsage(agent, usage),
    scopeBackgroundJobs: scopedBackgroundJobs,
    treeScope: (tree) => scopeAdmission(tree),
    bindGroupSignal,
  })
}

ensureAgentHostHooks()
