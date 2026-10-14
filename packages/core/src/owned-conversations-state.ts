import { unansweredCalls } from "@amira/ai"
import type { SessionStore } from "./session-store.ts"

export type InactiveConversationState = "idle" | "stopped" | "error"

/** Inspect durable originals before Agent repairs unanswered calls; never resume execution. */
export function restoredConversationState(store: SessionStore): InactiveConversationState {
  const messages = store.branch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
  const last = messages.at(-1)
  if (unansweredCalls(messages).size || last?.role === "user" || last?.role === "toolResult") return "stopped"
  if (last?.role === "assistant") {
    if (last.stopReason === "aborted" || last.stopReason === "toolUse") return "stopped"
    if (last.stopReason === "error") return "error"
  }
  return "idle"
}
