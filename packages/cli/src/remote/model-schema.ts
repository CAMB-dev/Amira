import type { RemoteJson } from "./protocol.ts"
import { REMOTE_LIMITS } from "./protocol.ts"
import { array, bool, enumeration, matches, object, type Schema, text } from "./schema/base.ts"
import { copyRemoteJson } from "./schema/json.ts"
import { compactResult, modelInfo, modelRequest, streamEvent, usage } from "./schema/messages.ts"

const schemas: Record<string, Schema> = {
  model: modelInfo,
  request: modelRequest,
  event: streamEvent,
  compact: compactResult,
  receipt: object({ id: text, late: bool, "usage?": usage }),
  metadata: array(
    object({
      revision: text,
      model: modelInfo,
      available: bool,
      replay: object({ dialect: text, provider: text, host: text, model: text, webSearch: bool }),
      "native?": object({
        dialect: text,
        methods: array(text),
        layouts: array(enumeration("tail", "recent-user")),
        midTurn: bool,
      }),
    }),
  ),
}

/** The same closed shape drives validation and observable-string projection. */
export function modelValueSchema(kind: string): Schema {
  const schema = schemas[kind]
  if (!schema) throw new Error("Invalid model schema")
  return schema
}

/** Local Ai uses explicit undefined optionals. Omit them without invoking getters/toJSON. */
function snapshot(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > REMOTE_LIMITS.nodes || depth > REMOTE_LIMITS.depth)
    throw new Error("Model payload limit exceeded")
  if (!value || typeof value !== "object") return value
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype)
    throw new Error("Invalid model payload")
  for (let parent = prototype; parent !== null; parent = Object.getPrototypeOf(parent)) {
    if (Object.hasOwn(parent, "toJSON")) throw new Error("Invalid model payload")
  }
  const result: Record<string, unknown> | unknown[] = array
    ? new Array((value as unknown[]).length)
    : Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error("Invalid model payload")
    if (array && key === "length") continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new Error("Invalid model payload")
    if (descriptor.value === undefined && !array) continue
    Object.defineProperty(result, key, {
      value: snapshot(descriptor.value, depth + 1, budget),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return result
}

/** Reuse the transport's closed DTO schemas so broker and wire validation cannot drift. */
export function validateModelValue(kind: string, value: unknown): RemoteJson {
  const schema = schemas[kind]
  const copy = copyRemoteJson(snapshot(value))
  if (!schema || !matches(copy, schema)) throw new Error("Invalid model payload")
  if (Buffer.byteLength(JSON.stringify(copy)) > REMOTE_LIMITS.logicalBytes)
    throw new Error("Model payload limit exceeded")
  return copy
}
