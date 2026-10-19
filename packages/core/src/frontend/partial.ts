import type { AnyEvent } from "@amira/api"

type Delta = Extract<AnyEvent, { type: "message.delta" }>
type Slot = { event: AnyEvent; bytes: number }
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

// JSON string bytes are additive except when two fragments join a surrogate pair.
function appendedBytes(previous: string, fragment: string): number {
  const high = previous.charCodeAt(previous.length - 1)
  const low = fragment.charCodeAt(0)
  return size(fragment) - 2 - (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 8 : 0)
}

/** Current blocks, not a delta log. Aggregates keep their first envelope's position and
 * timestamp (first visible token/tool appearance); structural timing envelopes stay original.
 * Sources are copied by the caller. Replacing slots never mutates a prior snapshot or journal.
 */
export class FrontendPartial {
  #slots: Slot[] = []
  #tools = new Map<string, number>()
  #hosted = new Map<string, number>()
  #last = -1
  bytes = 0

  get count(): number {
    return this.#slots.length
  }

  get events(): AnyEvent[] {
    return this.#slots.map((slot) => slot.event)
  }

  capture(event: AnyEvent): void {
    if (event.type !== "message.delta") {
      if (event.type === "message.stream" && event.data.kind === "request") {
        this.#tools.clear()
        this.#hosted.clear()
      }
      this.#put(event)
      return
    }
    const data = event.data
    let index: number | undefined
    if (data.kind === "toolCall") {
      const key = data.index === undefined ? `id:${data.toolCallId}` : `index:${data.index}`
      index = this.#tools.get(key)
      this.#tools.set(key, index ?? this.count)
    } else if (data.kind === "serverTool") {
      index = this.#hosted.get(data.block.id)
      this.#hosted.set(data.block.id, index ?? this.count)
    } else {
      const last = this.#slots[this.#last]?.event
      if (last?.type === "message.delta" && last.data.kind === data.kind) index = this.#last
    }
    const slot = index === undefined ? undefined : this.#slots[index]
    if (slot?.event.type !== "message.delta") {
      this.#put(event)
      return
    }
    const previous = slot.event
    let next: Delta = { ...previous, data }
    let bytes: number
    if (
      (data.kind === "text" || data.kind === "thinking") &&
      (previous.data.kind === "text" || previous.data.kind === "thinking")
    ) {
      next = { ...previous, data: { ...data, text: previous.data.text + data.text } }
      bytes = slot.bytes + appendedBytes(previous.data.text, data.text)
    } else if (data.kind === "toolCall" && previous.data.kind === "toolCall") {
      const merged = { ...previous.data, ...data, argsDelta: "" }
      next = { ...previous, data: { ...merged, argsDelta: previous.data.argsDelta + data.argsDelta } }
      bytes =
        slot.bytes +
        appendedBytes(previous.data.argsDelta, data.argsDelta) +
        size(merged) -
        size({ ...previous.data, argsDelta: "" })
    } else bytes = size(next)
    this.bytes += bytes - slot.bytes
    this.#slots[index!] = { event: next, bytes }
    this.#last = index!
  }

  #put(event: AnyEvent): void {
    const bytes = size(event)
    this.#last = this.count
    this.#slots.push({ event, bytes })
    this.bytes += bytes
  }
}
