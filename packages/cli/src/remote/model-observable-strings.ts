import type { UsageReceipt } from "@amira/ai/accounting"
import { ModelOutboundError } from "./model-codec.ts"
import { modelNumericForms } from "./model-numeric-forms.ts"
import { modelValueSchema } from "./model-schema.ts"
import type { RemoteJson } from "./protocol.ts"
import { matches, type Schema } from "./schema/base.ts"

export interface ModelStringRef {
  /** Numeric observations are immutable, including their equivalent decimal rendering. */
  readonly representations?: readonly string[]
  read(): string
  write(value: string): void
}
export interface ObservableModelItem {
  kind: string
  value: unknown
}

const numericRefs = new WeakMap<readonly string[], ModelStringRef>()
function numericRef(value: number, representations = modelNumericForms(value)): ModelStringRef {
  const cached = numericRefs.get(representations)
  if (cached) return cached
  const canonical = String(value)
  const ref: ModelStringRef = Object.freeze({
    representations,
    read: () => canonical,
    write: (masked: string) => {
      if (masked !== canonical) throw new ModelOutboundError(true)
    },
  })
  numericRefs.set(representations, ref)
  return ref
}

/** Schema-owned scaffolding is audited separately, never used to separate secret fragments. */
export function modelStringViews(
  item: ObservableModelItem,
  shape: RemoteJson,
  identity: number,
  receipts: readonly UsageReceipt[] = [],
  representations: (value: number) => readonly string[] = modelNumericForms,
): Map<string, ModelStringRef[]> {
  const views = new Map<string, ModelStringRef[]>()
  const all: ModelStringRef[] = []
  views.set("payload", all)
  const ref = (parent: Record<string, unknown> | unknown[], key: string | number): ModelStringRef => ({
    read: () => Reflect.get(parent, key) as string,
    write: (value) => {
      Reflect.set(parent, key, value)
    },
  })
  function collect(
    value: unknown,
    original: RemoteJson,
    schema: Schema,
    parent?: Record<string, unknown> | unknown[],
    key?: string | number,
  ): void {
    const alternatives = schema.anyOf ?? schema.oneOf
    if (alternatives) {
      const selected = alternatives.find((candidate) => matches(original, candidate))
      if (!selected) throw new ModelOutboundError()
      collect(value, original, selected, parent, key)
      return
    }
    if (typeof value === "string") {
      if (value.length && !schema.enum && parent && key !== undefined) all.push(ref(parent, key))
      return
    }
    if (typeof value === "number") {
      if (!schema.enum) all.push(numericRef(value, representations(value)))
      return
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++)
        collect(value[index], (original as RemoteJson[])[index]!, schema.items ?? {}, value, index)
      return
    }
    if (!value || typeof value !== "object") return
    const record = value as Record<string, unknown>
    const before = original as Record<string, RemoteJson>
    for (const [name, child] of Object.entries(record)) {
      if (child === undefined) continue // Local optional DTO fields disappear during encoding.
      const property = schema.properties?.[name]
      if (!property && name.length) {
        // Renaming dictionary keys can reorder JSON or change a tool argument's meaning.
        // A cross-field key match is unrepresentable and must fail closed instead.
        all.push({
          read: () => name,
          write: (masked) => {
            if (masked !== name) throw new ModelOutboundError()
          },
        })
      }
      collect(
        child,
        before?.[name] ?? (child as RemoteJson),
        property ?? (schema.additionalProperties || {}),
        record,
        name,
      )
    }
  }
  collect(item.value, shape, modelValueSchema(item.kind))
  // These numbers are generated after DTO serialization, including private known-cost
  // subtotals. Fixed receipt paths/field names are scaffolding, not protective padding.
  for (const receipt of receipts) {
    for (const value of Object.values(receipt))
      if (typeof value === "number") all.push(numericRef(value, representations(value)))
  }

  if (item.kind === "event") {
    const value = item.value as Record<string, unknown>
    const original = shape as Record<string, RemoteJson>
    const type = original.type
    if (type === "text.delta" || type === "thinking.delta" || type === "toolCall.delta") {
      const field = type === "toolCall.delta" ? "argsDelta" : "text"
      const part = ref(value, field)
      if (part.read().length) {
        views.set("chronological-deltas", [part])
        const lane = type === "toolCall.delta" ? `tool:${original.index ?? `id:${original.id}`}` : type
        views.set(`lane:${lane}`, [part])
      }
    }
    if (type === "done" || type === "error" || type === "request.end") {
      const message = value.message as { content: { type: string; text?: string }[] }
      const parts = message.content.filter(
        (block) => (block.type === "text" || block.type === "thinking") && block.text?.length,
      )
      views.set(
        `message:${identity}`,
        parts.map((block) => ref(block, "text")),
      )
      for (const lane of ["text", "thinking"]) {
        views.set(
          `message:${identity}:${lane}`,
          parts.filter((block) => block.type === lane).map((block) => ref(block, "text")),
        )
      }
    }
  }
  return views
}
