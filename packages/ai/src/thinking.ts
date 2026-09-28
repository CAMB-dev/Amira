import type { AssistantContent, Message } from "./types.ts"

/**
 * Prepares history for a dialect. Thinking can only be replayed to the dialect that signed
 * it; for any other dialect the reasoning is kept as text wrapped in <thinking> tags, so a
 * conversation survives a switch between providers (D9). Redacted thinking from another
 * dialect cannot be read and is dropped. Messages are copied, never modified.
 */
export function adaptThinking(messages: Message[], dialect: string): Message[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !m.content.some((b) => b.type === "thinking")) return m
    const content: AssistantContent[] = []
    for (const b of m.content) {
      if (b.type !== "thinking" || b.signature?.dialect === dialect) {
        content.push(b)
      } else if (!b.redacted && b.text.trim()) {
        content.push({ type: "text", text: `<thinking>\n${b.text}\n</thinking>` })
      }
    }
    return { ...m, content }
  })
}
