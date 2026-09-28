import { adaptThinking } from "../thinking.ts"
import type { AssistantMessage, ImageBlock, Message, TextBlock, ToolResultMessage } from "../types.ts"
import { indexResults, MISSING_RESULT, takeResult } from "./tool-results.ts"

export const ANTHROPIC_DIALECT = "anthropic-messages"

export type CacheControl = { type: "ephemeral" }

export type AnthropicBlock =
  | { type: "text"; text: string; cache_control?: CacheControl }
  | {
      type: "image"
      source: { type: "base64"; media_type: string; data: string }
      cache_control?: CacheControl
    }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result"
      tool_use_id: string
      content?: AnthropicBlock[]
      is_error?: boolean
      cache_control?: CacheControl
    }

export interface AnthropicMessage {
  role: "user" | "assistant"
  content: AnthropicBlock[]
}

/**
 * Translates history to Messages API turns. Roles must alternate, every tool_use must be
 * answered by a tool_result in the next user turn, and signed thinking goes back unchanged
 * where it was. Thinking signed elsewhere becomes text first.
 */
export function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const history = adaptThinking(messages, ANTHROPIC_DIALECT)
  const out: AnthropicMessage[] = []
  const push = (role: AnthropicMessage["role"], content: AnthropicBlock[]) => {
    if (!content.length) return
    const prev = out.at(-1)
    if (prev?.role === role) prev.content.push(...content)
    else out.push({ role, content })
  }
  const results = indexResults(history)
  history.forEach((m, i) => {
    if (m.role === "user") {
      push("user", m.content.flatMap(userBlock))
    } else if (m.role === "assistant") {
      const content = assistantBlocks(m)
      push("assistant", content)
      const answers = content
        .filter((b) => b.type === "tool_use")
        .map((call) => toolResult(call.id, takeResult(results, call.id, i)))
      push("user", answers)
    }
  })
  return out
}

function userBlock(b: TextBlock | ImageBlock): AnthropicBlock[] {
  if (b.type === "image") return [imageBlock(b)]
  return b.text ? [{ type: "text", text: b.text }] : []
}

function imageBlock(b: ImageBlock): AnthropicBlock {
  return { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } }
}

/** Keeps the block order: models that interleave thinking with tool calls need it unchanged. */
function assistantBlocks(m: AssistantMessage): AnthropicBlock[] {
  const out: AnthropicBlock[] = []
  for (const b of m.content) {
    if (b.type === "thinking") {
      // adaptThinking left only thinking signed by this dialect, or unsigned thinking.
      const sig = b.signature?.dialect === ANTHROPIC_DIALECT ? b.signature.value : ""
      if (b.redacted && sig) out.push({ type: "redacted_thinking", data: sig })
      else if (sig) out.push({ type: "thinking", thinking: b.text, signature: sig })
      else if (b.text.trim()) out.push({ type: "text", text: `<thinking>\n${b.text}\n</thinking>` })
    } else if (b.type === "text") {
      if (b.text) out.push({ type: "text", text: b.text })
    } else {
      out.push({ type: "tool_use", id: b.id, name: b.name, input: b.args })
    }
  }
  return out
}

function toolResult(id: string, result: ToolResultMessage | undefined): AnthropicBlock {
  if (!result) {
    return {
      type: "tool_result",
      tool_use_id: id,
      content: [{ type: "text", text: MISSING_RESULT }],
      is_error: true,
    }
  }
  const content = result.content.flatMap(userBlock)
  return {
    type: "tool_result",
    tool_use_id: id,
    ...(content.length ? { content } : {}),
    ...(result.isError ? { is_error: true } : {}),
  }
}

/**
 * Marks the last block of the last two user turns, so each request reads the prefix the
 * previous one wrote and writes the next. Returns how many breakpoints were placed.
 */
export function markCacheBreakpoints(messages: AnthropicMessage[], max: number): number {
  let placed = 0
  for (let i = messages.length - 1; i >= 0 && placed < Math.min(max, 2); i--) {
    const m = messages[i]!
    // User turns only hold text, image and tool_result blocks, which all take a breakpoint.
    const last =
      m.role === "user" ? (m.content.at(-1) as { cache_control?: CacheControl } | undefined) : undefined
    if (!last) continue
    last.cache_control = { type: "ephemeral" }
    placed++
  }
  return placed
}
