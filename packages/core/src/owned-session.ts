import type { ConversationSpec } from "@amira/api"
import type { AgentOptions } from "./agent/types.ts"

/** Durable marker: generic root acquisition and forks must not discard the owner's policy. */
export interface OwnedSessionIdentity {
  v: 1 | 2 | 3
  owner: string
  spec: ConversationSpec & { model: string }
  runtimeTools: string[]
}

export function assertOwnedSession(options: Pick<AgentOptions, "session" | "ownedConversation">): void {
  const identity = options.session?.header.owned
  if (identity !== undefined && (!identity || identity.owner !== options.ownedConversation)) {
    throw new Error("An owned conversation must be opened through its owning extension")
  }
}
