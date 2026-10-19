import type { Agent } from "../agent.ts"
import { sessionBranchEntries } from "../session-branch-reader.ts"
import { freezeSnapshot, frontendJson } from "./json.ts"
import { FrontendOperationError } from "./operations.ts"
import type { FrontendMessage } from "./snapshot.ts"

const SNAPSHOT_BYTES = 32 * 1024 * 1024
const PAGE_BYTES = 8 * 1024 * 1024
function failure(message: string): never {
  throw new FrontendOperationError("operation_failed", message)
}

/** Measures retained entries first. Only an accepted, bounded snapshot is then cloned/frozen. */
export function copyHistory(history: Iterable<unknown>, reverse = false) {
  let bytes = 0
  let nodes = 0
  const sizes: number[] = []
  const retained: unknown[] = []
  const ancestors = new Set<object>()
  const measure = (value: unknown, depth = 0): number => {
    if (++nodes > 100_000 || depth > 64) failure("Conversation history exceeds the snapshot limit")
    if (typeof value === "string") {
      if (Buffer.byteLength(value) > PAGE_BYTES) failure("A history entry exceeds the page limit")
      return Buffer.byteLength(JSON.stringify(value))
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") return 24
    if (!value || typeof value !== "object" || ancestors.has(value)) failure("Invalid conversation history")
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
      failure("Invalid conversation history")
    if (Array.isArray(value) && value.length > 100_000 - nodes)
      failure("Conversation history exceeds the snapshot limit")
    ancestors.add(value)
    let size = 2
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!Object.hasOwn(descriptor, "value")) failure("Invalid conversation history")
      if (descriptor.value === undefined) continue
      size += Buffer.byteLength(key) * 6 + 4 + measure(descriptor.value, depth + 1)
      if (size > PAGE_BYTES) failure("A history entry exceeds the page limit")
    }
    ancestors.delete(value)
    return size
  }
  for (const message of history) {
    if (retained.length >= 10_000) failure("Conversation history exceeds the snapshot limit")
    const size = measure(message)
    bytes += size
    if (bytes > SNAPSHOT_BYTES) failure("Conversation history exceeds the snapshot limit")
    sizes.push(size)
    retained.push(message)
  }
  if (reverse) {
    retained.reverse()
    sizes.reverse()
  }
  return {
    bytes,
    sizes,
    messages: freezeSnapshot(frontendJson(retained)) as unknown as readonly FrontendMessage[],
  }
}

/** Full current branch, including compacted originals, without materializing SessionStore.branch(). */
export function readAgentHistory(agent: Agent): ReturnType<typeof copyHistory> {
  if (!agent.session) return copyHistory(agent.messages)
  const entries = sessionBranchEntries(agent.session)
  function* messages() {
    for (const entry of entries) if (entry.type === "message") yield entry.message
  }
  return copyHistory(messages(), true)
}

export function historyPageEnd(sizes: readonly number[], offset: number, limit: number): number {
  let bytes = 0
  let end = offset
  while (end < sizes.length && end < offset + limit && bytes + sizes[end]! <= PAGE_BYTES)
    bytes += sizes[end++]!
  return end
}
