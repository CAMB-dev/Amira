import type { Message, ToolCallBlock, ToolResultMessage } from "../types.ts"

/** Sent for a tool call whose result is missing, so wire formats that require one stay valid. */
export const MISSING_RESULT = "[no result: the call did not complete]"

/**
 * A fresh prefix for ids made up for calls the server sent without one. It differs per reply,
 * so a made-up id never repeats one from an earlier step of the conversation.
 */
export function madeUpIdPrefix(): string {
  return `call_${crypto.randomUUID().slice(0, 8)}_`
}

export interface ResultIndex {
  /** Results by call id, in history order. */
  results: Map<string, { at: number; result: ToolResultMessage }[]>
  /** Where each call id is used, in history order: providers may reuse an id in a later step. */
  calls: Map<string, number[]>
}

/** Tool results by call id, so each call can be paired with its result wherever it sits in history. */
export function indexResults(messages: readonly Message[]): ResultIndex {
  const index: ResultIndex = { results: new Map(), calls: new Map() }
  messages.forEach((m, at) => {
    if (m.role === "toolResult") {
      const list = index.results.get(m.toolCallId) ?? []
      list.push({ at, result: m })
      index.results.set(m.toolCallId, list)
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type !== "toolCall") continue
        const list = index.calls.get(b.id) ?? []
        list.push(at)
        index.calls.set(b.id, list)
      }
    }
  })
  return index
}

/**
 * The first unused result for a call that comes after the call itself. When a later message
 * reuses the id, results after that message belong to the later call, so a call whose own
 * result is missing never takes the later call's.
 */
export function takeResult(index: ResultIndex, id: string, callAt: number): ToolResultMessage | undefined {
  const list = index.results.get(id)
  if (!list) return undefined
  const until = index.calls.get(id)?.find((at) => at > callAt) ?? Number.POSITIVE_INFINITY
  const pos = list.findIndex((r) => r.at > callAt && r.at < until)
  if (pos === -1) return undefined
  return list.splice(pos, 1)[0]?.result
}

/**
 * Tool calls in `messages` left without a result. Each result answers the earliest open call
 * with its id before it, so an id reused across steps counts once per call, and appending a
 * result for every call returned here makes the history complete (calling this again then
 * returns nothing).
 */
export function unansweredCalls(messages: readonly Message[]): Set<ToolCallBlock> {
  const open = new Map<string, ToolCallBlock[]>()
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type !== "toolCall") continue
        const list = open.get(b.id) ?? []
        list.push(b)
        open.set(b.id, list)
      }
    } else if (m.role === "toolResult") {
      open.get(m.toolCallId)?.shift()
    }
  }
  return new Set([...open.values()].flat())
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
