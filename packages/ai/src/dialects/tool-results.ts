import type { Message, ToolResultMessage } from "../types.ts"

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
