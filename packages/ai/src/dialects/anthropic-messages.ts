import { serverToolText } from "../server-tools.ts"
import { adaptThinking } from "../thinking.ts"
import type {
  AssistantMessage,
  ImageBlock,
  Message,
  TextBlock,
  ToolCallBlock,
  ToolResultMessage,
} from "../types.ts"
import { decodeSearchReplay, decodeSearchText } from "./anthropic-web-search.ts"
import { indexResults, MISSING_RESULT, takeResult } from "./tool-results.ts"

export const ANTHROPIC_DIALECT = "anthropic-messages"

export type CacheControl = { type: "ephemeral" }

export type AnthropicBlock =
  | { type: "text"; text: string; citations?: unknown[]; cache_control?: CacheControl }
  | { type: "server_tool_use"; [key: string]: any }
  | { type: "web_search_tool_result"; [key: string]: any }
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
  | CompactionBlock

/** The server's signed summary of compacted history (compaction on demand, beta). */
export interface CompactionBlock {
  type: "compaction"
  /** Readable summary text. */
  content: string
  signature: string
}

/** The compaction block a checkpoint's value holds, or undefined for anything else. */
export function decodeCompactionBlock(value: string): CompactionBlock | undefined {
  try {
    const v = JSON.parse(value)
    if (v?.type === "compaction" && typeof v.content === "string" && typeof v.signature === "string") {
      return { type: "compaction", content: v.content, signature: v.signature }
    }
  } catch {}
  return undefined
}

/** The checkpoint a message of a summary pair carries for this dialect (canReplay kept it). */
function checkpointOf(m: Message): CompactionBlock | undefined {
  if (m.role === "toolResult") return undefined
  for (const b of m.content) {
    const sig = b.type === "text" ? b.signature : undefined
    if (sig?.kind === "checkpoint" && sig.dialect === ANTHROPIC_DIALECT)
      return decodeCompactionBlock(sig.value)
  }
  return undefined
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
export function toAnthropicMessages(
  messages: Message[],
  opts: AnthropicMessageOptions = {},
): AnthropicMessage[] {
  const tools = opts.tools !== false
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
    // A server checkpoint goes as its compaction block, an assistant message of its own in
    // place of the summary pair (the user message's text and the acknowledgement after it).
    const checkpoint = checkpointOf(m)
    if (checkpoint) {
      if (m.role === "user") push("assistant", [checkpoint])
      return
    }
    if (m.role === "user") {
      push("user", m.content.flatMap(userBlock))
    } else if (m.role === "assistant") {
      push("assistant", assistantBlocks(m, tools, opts.webSearch !== false))
      const answers = m.content
        .filter((b) => b.type === "toolCall")
        .flatMap((call) => {
          const result = takeResult(results, call.id, i)
          return tools ? [toolResult(call.id, result)] : toolResultText(call, result)
        })
      push("user", answers)
    }
  })
  return out
}

export interface AnthropicMessageOptions {
  /** Whether the request sends tools; without them the API rejects tool blocks, so they become text. */
  tools?: boolean
  webSearch?: boolean
}

function userBlock(b: TextBlock | ImageBlock): AnthropicBlock[] {
  if (b.type === "image") return [imageBlock(b)]
  return b.text.trim() ? [{ type: "text", text: b.text }] : []
}

function imageBlock(b: ImageBlock): AnthropicBlock {
  return { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } }
}

/** Keeps the block order: models that interleave thinking with tool calls need it unchanged. */
function assistantBlocks(m: AssistantMessage, tools: boolean, webSearch: boolean): AnthropicBlock[] {
  const out: AnthropicBlock[] = []
  const pending = new Map<number, { block: AnthropicBlock; order: number }[]>()
  const resultsAt = (index: number) =>
    (pending.get(index) ?? []).sort((a, b) => a.order - b.order).map((r) => r.block)
  for (const [index, b] of m.content.entries()) {
    out.push(...resultsAt(index))
    if (b.type === "thinking") {
      // adaptThinking left only thinking signed by this dialect, or unsigned thinking.
      const sig = b.signature?.dialect === ANTHROPIC_DIALECT ? b.signature.value : ""
      if (b.redacted && sig) out.push({ type: "redacted_thinking", data: sig })
      else if (sig) out.push({ type: "thinking", thinking: b.text, signature: sig })
      else if (b.text.trim()) out.push({ type: "text", text: `<thinking>\n${b.text}\n</thinking>` })
    } else if (b.type === "text") {
      const raw =
        webSearch && b.signature?.dialect === ANTHROPIC_DIALECT && b.signature.kind === "webSearch"
          ? decodeSearchText(b.signature.value)
          : undefined
      if (raw && raw.text === b.text) out.push(raw as AnthropicBlock)
      else if (b.text.trim()) out.push({ type: "text", text: b.text })
    } else if (b.type === "serverTool") {
      const raw =
        webSearch && b.signature?.dialect === ANTHROPIC_DIALECT
          ? decodeSearchReplay(b.signature.value)
          : undefined
      if (raw) {
        out.push(raw.call as AnthropicBlock)
        if (raw.result) {
          const at = index + 1 + (raw.resultAfter ?? 0)
          pending.set(at, [
            ...(pending.get(at) ?? []),
            { block: raw.result as AnthropicBlock, order: raw.resultOrder ?? 0 },
          ])
        }
      } else out.push({ type: "text", text: serverToolText(b) })
    } else if (tools) {
      out.push({ type: "tool_use", id: wireToolId(b.id), name: b.name, input: b.args })
    } else {
      out.push({ type: "text", text: `[tool call ${b.name}(${JSON.stringify(b.args)})]` })
    }
  }
  out.push(...resultsAt(m.content.length))
  return out
}

function toolResultText(call: ToolCallBlock, result: ToolResultMessage | undefined): AnthropicBlock[] {
  const label = `[tool ${result?.isError ? "error" : "result"} from ${call.name}]`
  if (!result) return [{ type: "text", text: `${label}\n${MISSING_RESULT}` }]
  const texts = result.content.filter((b) => b.type === "text").map((b) => b.text)
  const images = result.content.filter((b) => b.type === "image").map(imageBlock)
  return [{ type: "text", text: [label, ...texts].join("\n") }, ...images]
}

const WIRE_ID = /^[a-zA-Z0-9_-]+$/

/**
 * Tool ids from other providers may hold characters the API rejects. They are mapped the
 * same way for a call and its result; the hash keeps distinct ids distinct.
 */
export function wireToolId(id: string): string {
  if (WIRE_ID.test(id)) return id
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193)
  return `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}_${(h >>> 0).toString(36)}`
}

function toolResult(callId: string, result: ToolResultMessage | undefined): AnthropicBlock {
  const id = wireToolId(callId)
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
