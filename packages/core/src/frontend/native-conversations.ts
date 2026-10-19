import type { OwnedConversation } from "@amira/api"
import type { Agent } from "../agent.ts"
import { readAgentHistory } from "./bounded-history.ts"
import { FrontendOperationError } from "./operations.ts"
import { FrontendProjection } from "./projection.ts"

interface NativeFrontend {
  check(): void
  agent: Agent
  projection: FrontendProjection
  sourceSeq: number
  persistenceLost: boolean
}
const frontends = new WeakMap<OwnedConversation, NativeFrontend>()

/** Installed before session.start or any owned execution, independently of frontend focus. */
export function registerNativeFrontend(
  conversation: OwnedConversation,
  agent: Agent,
  check: () => void,
): () => void {
  const projection = new FrontendProjection()
  const state = { agent, check, projection, sourceSeq: 0, persistenceLost: false }
  frontends.set(conversation, state)
  const off = agent.bus.capture(
    (event) => {
      state.sourceSeq = event.seq
      if (
        event.sessionId === agent.sessionId &&
        event.type === "extension.error" &&
        event.data.source === "session"
      )
        state.persistenceLost = true
      projection.capture(event)
    },
    () => projection.fail(),
  )
  return () => {
    off()
    projection.clear()
    if (frontends.get(conversation) === state) frontends.delete(conversation)
  }
}

function state(conversation: OwnedConversation): NativeFrontend {
  const value = frontends.get(conversation)
  if (!value) throw new Error("Native frontend state is unavailable")
  value.check()
  if (value.persistenceLost)
    throw new FrontendOperationError("operation_failed", "Native history requires persistence recovery")
  return value
}

/** Host-private branch budget checks precede public history's clone/materialization. */
export function nativeConversationHistory(
  conversation: OwnedConversation,
): ReturnType<typeof readAgentHistory> {
  return readAgentHistory(state(conversation).agent)
}

/** Throws on capture loss/overflow instead of certifying an incomplete RESET. */
export function nativeConversationActivity(
  conversation: OwnedConversation,
): ReturnType<FrontendProjection["inFlightSnapshot"]> & { sourceSeq: number } {
  const value = state(conversation)
  return { ...value.projection.inFlightSnapshot(), sourceSeq: value.sourceSeq }
}
