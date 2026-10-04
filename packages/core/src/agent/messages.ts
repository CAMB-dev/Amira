// Owns shared message, model-reference and tool-result helpers.
import type { ModelInfo, ModelRef, ToolCallBlock, ToolResultMessage, UserMessage } from "@amira/ai"
import type { ToolDefinition, ToolRejection, ToolResult } from "@amira/api"

/**
 * Steering messages that start a turn together, as one prompt. When any has a display, the
 * prompt's display lists each message's display (or text) in order.
 */
export function joinMessages(messages: UserMessage[]): UserMessage {
  if (messages.length === 1 && messages[0]) return messages[0]
  const joined: UserMessage = { role: "user", content: messages.flatMap((m) => m.content) }
  if (!messages.some((m) => m.display)) return joined
  const text = messages
    .map((m) => m.display?.text ?? m.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n"))
    .join("\n")
  const notes = messages.flatMap((m) => (m.display?.note ? [m.display.note] : []))
  // Notices of one kind stay notices; mixed with what the user wrote they read as the user's.
  const origins = new Set(messages.map((m) => m.display?.origin))
  const origin = origins.size === 1 ? [...origins][0] : undefined
  return {
    ...joined,
    display: { text, ...(notes.length ? { note: notes.join(" · ") } : {}), ...(origin ? { origin } : {}) },
  }
}

/** "12k": tokens for notices. */
export function formatK(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

export function modelRef(model: ModelInfo): ModelRef {
  return { provider: model.provider, model: model.id }
}

/** The tool's concurrency key for this call; a throwing key function means no key. */
export function concurrencyKey(
  tool: ToolDefinition | undefined,
  call: ToolCallBlock,
  cwd: string,
): string | undefined {
  if (!tool?.concurrencyKey) return undefined
  try {
    return tool.concurrencyKey(call.args, { cwd })
  } catch {
    return undefined
  }
}

/** Coerces whatever a tool returned into a valid result. */
export function normalizeResult(r: unknown): ToolResult {
  const content = (r as ToolResult | undefined)?.content
  if (!Array.isArray(content)) {
    return {
      content: [{ type: "text", text: "Tool returned an invalid result (missing content)." }],
      isError: true,
    }
  }
  const valid = content.filter(
    (b) =>
      (b?.type === "text" && typeof b.text === "string") ||
      (b?.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string"),
  )
  const out: ToolResult = { content: valid.length ? valid : [{ type: "text", text: "(no output)" }] }
  if ((r as ToolResult).isError) out.isError = true
  if ((r as ToolResult).details !== undefined) out.details = (r as ToolResult).details
  return out
}

/** A call's result, with why it was rejected, so a resumed session renders the call as the live one did. */
export function resultMessage(
  call: ToolCallBlock,
  r: ToolResult,
  rejected?: ToolRejection,
): ToolResultMessage {
  const m = { role: "toolResult" as const, toolCallId: call.id, toolName: call.name, content: r.content }
  return { ...m, isError: r.isError ?? false, ...(rejected && { rejected }) }
}

export function toolError(call: ToolCallBlock, text: string, rejected?: ToolRejection): ToolResultMessage {
  return resultMessage(call, { content: [{ type: "text", text }], isError: true }, rejected)
}

export function copyArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(args)
  } catch {
    return { ...args }
  }
}
