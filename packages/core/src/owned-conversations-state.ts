import { unansweredCalls } from "@amira/ai"
import type { SessionStore } from "./session-store.ts"

export type InactiveConversationState = "idle" | "stopped" | "error"

/** Inspect durable originals before Agent repairs unanswered calls; never resume execution. */
export function restoredConversationState(store: SessionStore): InactiveConversationState {
  const branch = store.branch()
  const latest = branch.findLast(
    (entry) => entry.type === "message" || (entry.type === "custom" && entry.ext === "amira.tool-operations"),
  )
  if (latest?.type === "custom") {
    const operation = latest.data as {
      v?: unknown
      phase?: unknown
      aborted?: unknown
      result?: { isError?: unknown }
    } | null
    if (operation?.v !== 1 || operation.phase !== "end" || operation.aborted === true) return "stopped"
    return operation.result?.isError === false ? "idle" : "error"
  }
  const messages = branch.flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
  const last = messages.at(-1)
  if (unansweredCalls(messages).size || last?.role === "user" || last?.role === "toolResult") return "stopped"
  if (last?.role === "assistant") {
    if (last.stopReason === "aborted" || last.stopReason === "toolUse") return "stopped"
    if (last.stopReason === "error") return "error"
  }
  return "idle"
}
