import type { AssistantMessage, ImageBlock, Message, ThinkingBlock, UserContent } from "../types.ts"
import { MISSING_RESULT, resultText, ToolResults } from "./tool-results.ts"

export const RESPONSES_DIALECT = "openai-responses"

type InputPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" }

type FunctionCallItem = { type: "function_call"; call_id: string; name: string; arguments: string }

export type ResponsesItem =
  | { type: "message"; role: "user"; content: InputPart[] }
  | { role: "assistant"; content: string }
  | {
      type: "message"
      id: string
      role: "assistant"
      status: "completed"
      content: { type: "output_text"; text: string; annotations: [] }[]
      phase?: string
    }
  | {
      type: "reasoning"
      id?: string
      summary: { type: "summary_text"; text: string }[]
      encrypted_content: string
    }
  | FunctionCallItem
  | { type: "function_call_output"; call_id: string; output: string }

export interface ResponsesInputOptions {
  /** Whether the model accepts images; tool-result images then follow as a user message. */
  images?: boolean
}

/** What a reasoning item's signature holds, so it can be replayed without server state. */
export interface ReasoningSignature {
  id?: string
  encrypted_content: string
}

export function encodeReasoning(sig: ReasoningSignature): string {
  return JSON.stringify(sig)
}

export function decodeReasoning(value: string): ReasoningSignature {
  try {
    const v = JSON.parse(value)
    if (typeof v?.encrypted_content === "string") return v
  } catch {}
  return { encrypted_content: value }
}

/** What an output message's signature holds, so its text replays as the same item. */
export interface MessageSignature {
  id: string
  phase?: string
}

export function encodeMessage(sig: MessageSignature): string {
  return JSON.stringify(sig)
}

function decodeMessage(value: string): MessageSignature | undefined {
  try {
    const v = JSON.parse(value)
    if (typeof v?.id === "string" && v.id) return v
  } catch {}
  return undefined
}

/**
 * Translates history to Responses API input items. Every function call is answered by
 * its output right after the assistant turn; missing ones are synthesized, stray ones dropped.
 */
export function toResponsesInput(messages: Message[], opts: ResponsesInputOptions = {}): ResponsesItem[] {
  const out: ResponsesItem[] = []
  const results = new ToolResults(messages)
  messages.forEach((m, i) => {
    if (m.role === "user") {
      out.push({ type: "message", role: "user", content: m.content.map(inputPart) })
      return
    }
    if (m.role !== "assistant") return
    const calls = assistantItems(m, out)
    const images: InputPart[] = []
    for (const call of calls) {
      const result = results.take(call.call_id, i)
      if (!result) {
        out.push({ type: "function_call_output", call_id: call.call_id, output: MISSING_RESULT })
        continue
      }
      const where = opts.images ? ", sent in the next message" : ""
      out.push({ type: "function_call_output", call_id: call.call_id, output: resultText(result, where) })
      const shots = result.content.filter((b) => b.type === "image")
      if (opts.images && shots.length) {
        images.push(
          { type: "input_text", text: `Images from the ${result.toolName} result (${result.toolCallId}):` },
          ...shots.map(imagePart),
        )
      }
    }
    if (images.length) out.push({ type: "message", role: "user", content: images })
  })
  return out
}

/**
 * Appends an assistant turn's items in order and returns its function calls. Text with a
 * known item id replays as that output message, other text as a plain assistant message.
 * Reasoning must be followed by the output it led to, so trailing reasoning is dropped.
 */
function assistantItems(m: AssistantMessage, out: ResponsesItem[]): FunctionCallItem[] {
  const items: ResponsesItem[] = []
  let plain: { role: "assistant"; content: string } | undefined
  for (const b of m.content) {
    const known =
      b.type === "text" && b.signature?.dialect === RESPONSES_DIALECT
        ? decodeMessage(b.signature.value)
        : undefined
    if (b.type !== "text" || known) plain = undefined
    if (b.type === "text") {
      if (!b.text) continue
      if (known) {
        items.push({
          type: "message",
          id: known.id,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: b.text, annotations: [] }],
          ...(known.phase ? { phase: known.phase } : {}),
        })
      } else if (plain) {
        plain.content += b.text
      } else {
        plain = { role: "assistant", content: b.text }
        items.push(plain)
      }
    } else if (b.type === "thinking") {
      const item = reasoningItem(b)
      if (item) items.push(item)
    } else {
      items.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.args) })
    }
  }
  while (items.length && itemType(items.at(-1)) === "reasoning") items.pop()
  out.push(...items)
  return items.filter((i): i is FunctionCallItem => itemType(i) === "function_call")
}

function itemType(item: ResponsesItem | undefined): string | undefined {
  return item && "type" in item ? item.type : undefined
}

/** Only signed reasoning can be replayed, under the id it was given. */
function reasoningItem(b: ThinkingBlock): ResponsesItem | undefined {
  if (b.signature?.dialect !== RESPONSES_DIALECT) return undefined
  const { id, encrypted_content } = decodeReasoning(b.signature.value)
  return {
    type: "reasoning",
    ...(id ? { id } : {}),
    summary: b.text ? [{ type: "summary_text", text: b.text }] : [],
    encrypted_content,
  }
}

function inputPart(b: UserContent): InputPart {
  return b.type === "text" ? { type: "input_text", text: b.text } : imagePart(b)
}

function imagePart(b: ImageBlock): InputPart {
  return { type: "input_image", image_url: `data:${b.mimeType};base64,${b.data}`, detail: "auto" }
}
