import type { CompactReceipt, CompactResult, ModelInfo, ModelRequest, StreamEvent } from "@amira/ai"
import { decodeUsageReceipt, encodeUsageReceipt, type UsageReceipt } from "@amira/ai/accounting"
import { validateModelValue } from "./model-schema.ts"
import { copyRemoteJson } from "./schema/json.ts"
import { secretPatterns } from "./secret-patterns.ts"

/** Accounting stays beside the public Usage value, never in it. Paths are schema-owned. */
export interface ModelWireValue<T> {
  value: T
  usage: { path: string[]; receipt: UsageReceipt }[]
}

function usagePaths(kind: string, value: unknown): string[][] {
  const record = value as Record<string, unknown>
  if (kind === "request") {
    return (record.messages as ModelRequest["messages"]).flatMap((message, index) =>
      message.role === "assistant" && message.usage ? [["messages", String(index), "usage"]] : [],
    )
  }
  if (kind === "event") {
    const message = record.message as Record<string, unknown> | undefined
    return message?.usage ? [["message", "usage"]] : []
  }
  return record.usage ? [["usage"]] : []
}

function at(value: unknown, path: string[]): Parameters<typeof encodeUsageReceipt>[0] {
  let target = value as Record<string, unknown>
  for (const key of path) target = target[key] as Record<string, unknown>
  return target as unknown as Parameters<typeof encodeUsageReceipt>[0]
}

export class ModelOutboundError extends Error {
  constructor(readonly immutableScalar = false) {
    super("Local model response failed security validation")
  }
}

/** Audit the final representation, not just string leaves: numbers and private sidecars count too. */
export function assertModelOutbound(value: unknown, secrets: readonly string[]): void {
  const copy = copyRemoteJson(value)
  const encoded = JSON.stringify(copy)
  if (!secrets.length) return
  const facts = secretPatterns(secrets)
  if (facts.contains(encoded)) throw new ModelOutboundError()
  // JSON may spell a decimal credential as an exponent (or round it). Do not let numeric
  // leaves expose that same value just because its serialized spelling differs.
  const numeric = facts.numeric
  const inspect = (item: unknown): void => {
    if (typeof item === "number" && numeric.has(item)) throw new ModelOutboundError()
    if (item && typeof item === "object") for (const child of Object.values(item)) inspect(child)
  }
  if (numeric.size) inspect(copy)
}

function encode<T>(kind: string, value: T, secrets: readonly string[] = []): ModelWireValue<T> {
  try {
    const copy = validateModelValue(kind, value) as T
    const usage = usagePaths(kind, copy).map((path) => ({
      path,
      receipt: encodeUsageReceipt(at(value, path)),
    }))
    const wire = { value: copy, usage }
    assertModelOutbound(wire, secrets)
    return wire
  } catch (error) {
    // A credential matching an enum/key may make a masked value unrepresentable. This is
    // the same security rejection as a remaining secret, never evidence of zero usage.
    if (secrets.length) throw new ModelOutboundError()
    throw error
  }
}

function decode<T>(kind: string, wire: unknown): T {
  const record = copyRemoteJson(wire) as Record<string, unknown>
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).some((key) => key !== "value" && key !== "usage") ||
    !Array.isArray(record.usage)
  )
    throw new Error("Invalid model wire value")
  const result = encode(kind, record.value)
  if (record.usage.length !== result.usage.length) throw new Error("Invalid usage receipts")
  for (let index = 0; index < result.usage.length; index++) {
    const entry = record.usage[index] as Record<string, unknown>
    const expected = result.usage[index]!
    if (
      !entry ||
      Object.keys(entry).some((key) => key !== "path" && key !== "receipt") ||
      JSON.stringify(entry.path) !== JSON.stringify(expected.path)
    )
      throw new Error("Invalid usage receipt path")
    decodeUsageReceipt(at(result.value, expected.path), entry.receipt)
  }
  return result.value as T
}

export const encodeModelRequest = (value: ModelRequest) => encode("request", value)
export const decodeModelRequest = (value: unknown) => decode<ModelRequest>("request", value)
export const encodeModelEvent = (value: StreamEvent, secrets?: readonly string[]) =>
  encode("event", value, secrets)
export const decodeModelEvent = (value: unknown) => decode<StreamEvent>("event", value)
export const encodeCompactResult = (value: CompactResult, secrets?: readonly string[]) =>
  encode("compact", value, secrets)
export const decodeCompactResult = (value: unknown) => decode<CompactResult>("compact", value)
export const encodeCompactReceipt = (value: CompactReceipt, secrets?: readonly string[]) =>
  encode("receipt", value, secrets)
export const decodeCompactReceipt = (value: unknown) => decode<CompactReceipt>("receipt", value)
export const copyModelInfo = (value: ModelInfo): ModelInfo =>
  validateModelValue("model", value) as unknown as ModelInfo
