import type { Message } from "../types.ts"

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }

interface ChatToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export function toChatMessages(systemPrompt: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = []
  if (systemPrompt) out.push({ role: "system", content: systemPrompt })
  for (const m of messages) {
    if (m.role === "user") {
      const onlyText = m.content.every((b) => b.type === "text")
      out.push({
        role: "user",
        content: onlyText
          ? m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
          : m.content.map(
              (b): ChatPart =>
                b.type === "text"
                  ? { type: "text", text: b.text }
                  : { type: "image_url", image_url: { url: `data:${b.mimeType};base64,${b.data}` } },
            ),
      })
    } else if (m.role === "assistant") {
      // Chat Completions has no way to send thinking back, so it is dropped here.
      const textOut = m.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
      const calls = m.content
        .filter((b) => b.type === "toolCall")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.args) },
        }))
      const msg: ChatMessage = { role: "assistant", content: textOut || null }
      if (calls.length) msg.tool_calls = calls
      out.push(msg)
    } else {
      const body = m.content.map((b) => (b.type === "text" ? b.text : `[image: ${b.mimeType}]`)).join("\n")
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: body })
    }
  }
  return out
}
