import type { ToolRejection, ToolResult } from "@amira/api"

/** A tool call of the current step, from its start until it is committed. */
export interface TrackedCall {
  id: string
  name: string
  args: Record<string, unknown>
  startedAt: number
  /** The latest tool.execute.update. */
  partial?: ToolResult
  /** Set once it finished. */
  end?: { result: ToolResult; durationMs: number; rejected?: ToolRejection }
}

/**
 * Keeps the tool calls of a turn in the order the model made them. Parallel calls finish in
 * any order, but the transcript shows them in call order: a call that finished is held until
 * every call before it has been committed (the live region shows the held ones meanwhile).
 */
export class ToolCalls {
  /** Ids not committed yet, in call order. */
  #order: string[] = []
  #calls = new Map<string, TrackedCall>()

  /** The calls a reply made, in order, before any of them starts. */
  expect(ids: string[]): void {
    for (const id of ids) if (!this.#order.includes(id)) this.#order.push(id)
  }

  start(id: string, name: string, args: Record<string, unknown>, at: number): void {
    if (!this.#order.includes(id)) this.#order.push(id)
    const known = this.#calls.get(id)
    if (known) {
      known.name = name
      known.args = args
      return
    }
    this.#calls.set(id, { id, name, args, startedAt: at })
  }

  update(id: string, partial: ToolResult): void {
    const call = this.#calls.get(id)
    if (call && !call.end) call.partial = partial
  }

  /** Marks the call finished; returns the calls that can be committed now, in call order. */
  end(id: string, end: NonNullable<TrackedCall["end"]>): TrackedCall[] {
    const call = this.#calls.get(id)
    if (!call) return []
    call.end = end
    const ready: TrackedCall[] = []
    while (this.#order.length) {
      const next = this.#calls.get(this.#order[0]!)
      if (!next?.end) break
      ready.push(next)
      this.#order.shift()
      this.#calls.delete(next.id)
    }
    return ready
  }

  /** Started calls not committed yet, in call order: running ones and finished ones held back. */
  get live(): TrackedCall[] {
    return this.#order.flatMap((id) => this.#calls.get(id) ?? [])
  }

  get running(): number {
    let n = 0
    for (const c of this.#calls.values()) if (!c.end) n++
    return n
  }

  /** Ends the turn: returns the finished calls still held, in order, and forgets the rest. */
  flush(): TrackedCall[] {
    const done = this.live.filter((c) => c.end)
    this.#order = []
    this.#calls.clear()
    return done
  }
}
