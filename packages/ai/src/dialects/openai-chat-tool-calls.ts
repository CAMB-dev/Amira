import { madeUpIdPrefix } from "./tool-results.ts"

export interface PendingCall {
  id: string
  name: string
  args: string
}

export interface ToolCallDelta {
  type: "toolCall.delta"
  index: number
  id: string
  name?: string
  argsDelta: string
}

/**
 * Assembles streamed tool-call deltas. Servers differ: some omit `index`, some send a
 * placeholder id first, some repeat the full name on every delta.
 */
export class ToolCallAssembler {
  /** Calls in first-seen order. */
  readonly calls: PendingCall[] = []
  readonly #slots = new Map<number, PendingCall>()
  readonly #idKnown = new Set<PendingCall>()
  readonly #idPrefix = madeUpIdPrefix()

  apply(toolCalls: unknown): ToolCallDelta[] {
    if (!Array.isArray(toolCalls)) return []
    return toolCalls.map((tc: any, position) => {
      const hasIndex = typeof tc?.index === "number"
      const slot = hasIndex ? tc.index : position
      const id = typeof tc?.id === "string" && tc.id ? tc.id : undefined
      let call = this.#slots.get(slot)
      // Without an index, a new id in a slot means a new call.
      if (!call || (!hasIndex && id && this.#idKnown.has(call) && id !== call.id)) {
        call = { id: `${this.#idPrefix}${this.calls.length}`, name: "", args: "" }
        this.calls.push(call)
        this.#slots.set(slot, call)
      }
      if (id && !this.#idKnown.has(call)) {
        call.id = id
        this.#idKnown.add(call)
      }
      const name = tc?.function?.name
      if (typeof name === "string" && name) call.name = mergeName(call.name, name)
      const argsDelta = typeof tc?.function?.arguments === "string" ? tc.function.arguments : ""
      call.args += argsDelta
      return {
        type: "toolCall.delta" as const,
        index: this.calls.indexOf(call),
        id: call.id,
        ...(call.name ? { name: call.name } : {}),
        argsDelta,
      }
    })
  }
}

/** Some servers stream the name in pieces, others repeat it whole on every delta. */
function mergeName(current: string, incoming: string): string {
  if (!current || incoming.startsWith(current)) return incoming
  return current + incoming
}
