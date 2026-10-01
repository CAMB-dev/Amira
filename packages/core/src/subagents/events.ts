import type { Agent } from "../agent.ts"
import type { EmitMeta } from "../event-bus.ts"

/** A parent's ids without its turn: a child can end after the turn that started it. */
export function parentMeta(parent: Agent): EmitMeta {
  const meta: EmitMeta = { sessionId: parent.sessionId }
  if (parent.parentSessionId) meta.parentSessionId = parent.parentSessionId
  return meta
}

export function metaOf(agent: Agent): EmitMeta {
  const meta: EmitMeta = { sessionId: agent.sessionId }
  if (agent.parentSessionId) meta.parentSessionId = agent.parentSessionId
  if (agent.turnId) meta.turnId = agent.turnId
  return meta
}
