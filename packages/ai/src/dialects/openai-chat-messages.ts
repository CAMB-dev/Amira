import type { AssistantMessage, ImageBlock, Message, ToolResultMessage, UserContent } from "../types.ts"
import { indexResults, MISSING_RESULT, takeResult } from "./tool-results.ts"

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

export interface ChatMessageOptions {
  /** Whether the model accepts images; tool-result images then follow as a user message. */
  images?: boolean
}

export { MISSING_RESULT }

/**
 * Translates history to Chat Completions messages. The wire format is strict: every
 * tool call must be answered by tool messages directly after it, so results are
 * reordered, missing ones are synthesized and stray ones are dropped.
 */
export function toChatMessages(
  systemPrompt: string,
  messages: Message[],
  opts: ChatMessageOptions = {},
): ChatMessage[] {
  const out: ChatMessage[] = []
  if (systemPrompt) out.push({ role: "system", content: systemPrompt })
  const results = indexResults(messages)
  messages.forEach((m, i) => {
    if (m.role === "user") {
      out.push({ role: "user", content: userContent(m.content) })
    } else if (m.role === "assistant") {
      const msg = assistantMessage(m)
      if (!msg) return
      out.push(msg)
      const images: ChatPart[] = []
      for (const call of msg.tool_calls ?? []) {
        const result = takeResult(results, call.id, i)
        if (!result) {
          out.push({ role: "tool", tool_call_id: call.id, content: MISSING_RESULT })
          continue
        }
        out.push({ role: "tool", tool_call_id: call.id, content: toolText(result, opts) })
        if (opts.images) images.push(...toolImages(result))
      }
      if (images.length) out.push({ role: "user", content: images })
    }
  })
  return out
}

function userContent(blocks: UserContent[]): string | ChatPart[] {
  if (blocks.every((b) => b.type === "text"))
    return blocks.map((b) => (b.type === "text" ? b.text : "")).join("")
  return blocks.map((b): ChatPart => (b.type === "text" ? { type: "text", text: b.text } : imagePart(b)))
}

/** Returns nothing for an empty message, which strict servers reject. */
function assistantMessage(m: AssistantMessage): Extract<ChatMessage, { role: "assistant" }> | undefined {
  // Chat Completions has no way to send thinking back, so it is dropped here.
  const text = m.content
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
  if (!calls.length) return text ? { role: "assistant", content: text } : undefined
  return { role: "assistant", content: text || null, tool_calls: calls }
}

function toolText(result: ToolResultMessage, opts: ChatMessageOptions): string {
  const where = opts.images ? ", sent in the next message" : ""
  return result.content.map((b) => (b.type === "text" ? b.text : `[image: ${b.mimeType}${where}]`)).join("\n")
}

function toolImages(result: ToolResultMessage): ChatPart[] {
  const images = result.content.filter((b) => b.type === "image")
  if (!images.length) return []
  return [
    { type: "text", text: `Images from the ${result.toolName} result (${result.toolCallId}):` },
    ...images.map(imagePart),
  ]
}

function imagePart(b: ImageBlock): ChatPart {
  return { type: "image_url", image_url: { url: `data:${b.mimeType};base64,${b.data}` } }
}
