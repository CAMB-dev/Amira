import { RemoteError } from "../errors.ts"
import { REMOTE_LIMITS, type RemoteJson } from "../protocol.ts"

/** Check JSON without invoking property getters or serialization hooks. */
export function assertRemoteJson(value: unknown): asserts value is RemoteJson {
  copyRemoteJson(value)
}

/** Capture data descriptors once; validation and serialization must use this inert snapshot. */
export function copyRemoteJson(value: unknown): RemoteJson {
  return copy(value, 0, new Set(), { nodes: 0 })
}
function copy(value: unknown, depth: number, seen: Set<object>, budget: { nodes: number }): RemoteJson {
  if (++budget.nodes > REMOTE_LIMITS.nodes)
    throw new RemoteError("limit_exceeded", "JSON node limit exceeded")
  if (depth > REMOTE_LIMITS.depth) throw new RemoteError("limit_exceeded", "JSON nesting limit exceeded")
  if (typeof value === "string" && value.length > REMOTE_LIMITS.logicalBytes)
    throw new RemoteError("limit_exceeded", "Logical payload string limit exceeded")
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "object" || seen.has(value))
    throw new RemoteError("invalid_frame", "Expected finite JSON")
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new RemoteError("invalid_frame", "Expected plain JSON prototypes")
  // Also reject poisoned standard prototypes, even though records lose their prototypes in the copy.
  for (let parent = prototype; parent !== null; parent = Object.getPrototypeOf(parent)) {
    if (Object.hasOwn(parent, "toJSON"))
      throw new RemoteError("invalid_frame", "Inherited serialization hooks are not JSON")
  }
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key === "symbol"))
    throw new RemoteError("invalid_frame", "Symbol keys are not JSON")
  if (keys.length > REMOTE_LIMITS.nodes - budget.nodes)
    throw new RemoteError("limit_exceeded", "JSON node limit exceeded")
  // Capture every sibling before descending: descriptor traps may mutate the original object.
  const entries = keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)] as const)
  const length = array ? entries.find(([key]) => key === "length")?.[1]?.value : 0
  if (array && (!Number.isSafeInteger(length) || length < 0))
    throw new RemoteError("invalid_frame", "Expected a plain JSON array length")
  if (array && length > REMOTE_LIMITS.nodes - budget.nodes)
    throw new RemoteError("limit_exceeded", "JSON node limit exceeded")
  if (array && keys.length !== length + 1)
    throw new RemoteError("invalid_frame", "Sparse arrays are not JSON data")
  const result: RemoteJson = array ? [] : Object.create(null)
  seen.add(value)
  for (const [key, descriptor] of entries) {
    if (array && key === "length") continue
    if (
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      (array && (!/^(0|[1-9][0-9]*)$/.test(String(key)) || Number(key) >= length))
    )
      throw new RemoteError("invalid_frame", "Expected plain JSON data properties")
    Object.defineProperty(result, key, {
      value: copy(descriptor.value, depth + 1, seen, budget),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  seen.delete(value)
  return result
}
