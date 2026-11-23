import { type AssistantMessage, type Message, unansweredCalls } from "@amira/ai"

/**
 * The parent's conversation as a child's starting point (context "fork"). The parent is in
 * the middle of a tool call, so calls without a result are dropped; an assistant message left
 * without content gets a placeholder so roles keep alternating for every provider.
 */
export function forkHistory(messages: readonly Message[]): Message[] {
  const unanswered = unansweredCalls(messages)
  return messages.map((m) => {
    if (m.role !== "assistant") return m
    const content = m.content.filter((b) => b.type !== "toolCall" || !unanswered.has(b))
    if (content.length === m.content.length) return m
    const kept = content.some((b) => b.type === "text" && b.text.trim())
    return {
      ...m,
      content: kept ? content : [...content, { type: "text", text: "(Delegating to sub-agents.)" }],
    } as AssistantMessage
  })
}

/** The text of the last assistant reply. */
export function finalText(messages: readonly Message[]): string {
  const last = messages.findLast((m) => m.role === "assistant" && m.content.some((b) => b.type === "text"))
  if (last?.role !== "assistant") return ""
  return last.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("")
    .trim()
}
