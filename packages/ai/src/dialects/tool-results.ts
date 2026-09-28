import type { Message, ToolResultMessage } from "../types.ts"

export { MISSING_RESULT } from "./openai-chat-messages.ts"

/**
 * Pairs tool calls with their results. Wire formats want each result right after its
 * call, so a result is taken by id from anywhere after the call, at most once.
 */
export class ToolResults {
  readonly #index = new Map<string, { at: number; result: ToolResultMessage }[]>()

  constructor(messages: Message[]) {
    messages.forEach((m, at) => {
      if (m.role !== "toolResult") return
      const list = this.#index.get(m.toolCallId) ?? []
      list.push({ at, result: m })
      this.#index.set(m.toolCallId, list)
    })
  }

  /** The first unused result for a call that comes after the call itself. */
  take(id: string, callAt: number): ToolResultMessage | undefined {
    const list = this.#index.get(id)
    const pos = list?.findIndex((r) => r.at > callAt) ?? -1
    if (!list || pos === -1) return undefined
    return list.splice(pos, 1)[0]?.result
  }
}

/** A result's text, with a placeholder for each image; `where` says where images went. */
export function resultText(result: ToolResultMessage, where = ""): string {
  return result.content.map((b) => (b.type === "text" ? b.text : `[image: ${b.mimeType}${where}]`)).join("\n")
}
