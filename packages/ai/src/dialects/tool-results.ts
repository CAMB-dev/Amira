import type { Message, ToolResultMessage } from "../types.ts"

/** Sent for a tool call whose result is missing, so wire formats that require one stay valid. */
export const MISSING_RESULT = "[no result: the call did not complete]"

export type ResultIndex = Map<string, { at: number; result: ToolResultMessage }[]>

/** Tool results by call id, so each call can be paired with its result wherever it sits in history. */
export function indexResults(messages: Message[]): ResultIndex {
  const index: ResultIndex = new Map()
  messages.forEach((m, at) => {
    if (m.role !== "toolResult") return
    const list = index.get(m.toolCallId) ?? []
    list.push({ at, result: m })
    index.set(m.toolCallId, list)
  })
  return index
}

/** The first unused result for a call that comes after the call itself. */
export function takeResult(index: ResultIndex, id: string, callAt: number): ToolResultMessage | undefined {
  const list = index.get(id)
  const pos = list?.findIndex((r) => r.at > callAt) ?? -1
  if (!list || pos === -1) return undefined
  return list.splice(pos, 1)[0]?.result
}

/**
 * Pairs tool calls with their results. Wire formats want each result right after its
 * call, so a result is taken by id from anywhere after the call, at most once.
 */
export class ToolResults {
  readonly #index: ResultIndex

  constructor(messages: Message[]) {
    this.#index = indexResults(messages)
  }

  take(id: string, callAt: number): ToolResultMessage | undefined {
    return takeResult(this.#index, id, callAt)
  }
}

/** A result's text, with a placeholder for each image; `where` says where images went. */
export function resultText(result: ToolResultMessage, where = ""): string {
  return result.content.map((b) => (b.type === "text" ? b.text : `[image: ${b.mimeType}${where}]`)).join("\n")
}
