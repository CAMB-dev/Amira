import type { ModelOutboundItem } from "../../src/remote/model-outbound-filter.ts"
import { modelValueSchema } from "../../src/remote/model-schema.ts"
import type { RemoteJson } from "../../src/remote/protocol.ts"
import { matches, type Schema } from "../../src/remote/schema/base.ts"

type Path = (string | number)[]
interface Ref {
  path: Path
  key: boolean
}
export interface FieldCase {
  name: string
  kind: ModelOutboundItem["kind"]
  fixtureJson: string
  ref: Ref
}

function selected(schema: Schema, value: RemoteJson): Schema {
  const alternatives = schema.oneOf ?? schema.anyOf
  if (!alternatives) return schema
  const branch = alternatives.find((branch) => matches(value, branch))
  if (!branch) throw new Error("Fixture does not match any model schema branch")
  return selected(branch, value)
}

/** Include optional fields, all array block alternatives, and freeform JSON keys and leaves. */
function example(schema: Schema): RemoteJson {
  const alternatives = schema.oneOf ?? schema.anyOf
  if (alternatives) {
    // Prefer the branch with the largest string surface (e.g. service-tier over false).
    return alternatives.map(example).sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0]!
  }
  if (schema.enum) return schema.enum[0]!
  switch (schema.type) {
    case "string":
      return ""
    case "number":
    case "integer":
      return schema.minimum ?? 0
    case "boolean":
      return false
    case "null":
      return null
    case "array": {
      const item = schema.items ?? {}
      return (item.oneOf ?? item.anyOf ?? [item]).map(example)
    }
    case "object": {
      const value: Record<string, RemoteJson> = {}
      for (const [key, child] of Object.entries(schema.properties ?? {})) value[key] = example(child)
      if (schema.additionalProperties && !Object.keys(value).length)
        value[""] = example(schema.additionalProperties)
      return value
    }
    default:
      // Arbitrary tool JSON must exercise nested values, arrays, and dictionary keys.
      return { "": [""] }
  }
}

export function variableRefs(value: RemoteJson, schema: Schema, path: Path = []): Ref[] {
  schema = selected(schema, value)
  if (schema.enum) return []
  if (typeof value === "string") return [{ path, key: false }]
  if (!value || typeof value !== "object") return []
  if (Array.isArray(value))
    return value.flatMap((child, index) => variableRefs(child, schema.items ?? {}, [...path, index]))
  const refs: Ref[] = []
  for (const [key, child] of Object.entries(value)) {
    const field = schema.properties?.[key]
    if (!field) refs.push({ path: [...path, key], key: true })
    refs.push(
      ...variableRefs(
        child,
        field ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : {}),
        [...path, key],
      ),
    )
  }
  return refs
}

export function payloadStrings(value: RemoteJson, schema: Schema): string[] {
  return variableRefs(value, schema).map((ref) => {
    if (ref.key) return String(ref.path.at(-1))
    let child = value
    for (const segment of ref.path) child = (child as Record<string | number, RemoteJson>)[segment]!
    return child as string
  })
}

function blank(schema: Schema, value: RemoteJson): RemoteJson {
  schema = selected(schema, value)
  if (schema.enum) return value
  if (typeof value === "string") return ""
  if (Array.isArray(value)) return []
  if (!value || typeof value !== "object") return value
  const result: Record<string, RemoteJson> = {}
  for (const [key, child] of Object.entries(value)) {
    if (schema.required?.includes(key)) result[key] = blank(schema.properties?.[key] ?? {}, child)
  }
  return result
}

/** Strip unrelated optional leaves and blocks, preserving required schema-owned tags. */
function isolate(schema: Schema, value: RemoteJson, ref: Ref): { value: RemoteJson; ref: Ref } {
  if (!ref.path.length) return { value, ref }
  schema = selected(schema, value)
  const [head, ...tail] = ref.path
  if (Array.isArray(value)) {
    const child = isolate(schema.items ?? {}, value[Number(head)]!, { ...ref, path: tail })
    return { value: [child.value], ref: { ...child.ref, path: [0, ...child.ref.path] } }
  }
  const result = blank(schema, value) as Record<string, RemoteJson>
  const key = String(head)
  if (ref.key && !tail.length) {
    result[key] = blank(
      schema.properties?.[key] ??
        (typeof schema.additionalProperties === "object" ? schema.additionalProperties : {}),
      (value as Record<string, RemoteJson>)[key]!,
    )
    return { value: result, ref }
  }
  const child = isolate(
    schema.properties?.[key] ??
      (typeof schema.additionalProperties === "object" ? schema.additionalProperties : {}),
    (value as Record<string, RemoteJson>)[key]!,
    { ...ref, path: tail },
  )
  result[key] = child.value
  return { value: result, ref: { ...child.ref, path: [key, ...child.ref.path] } }
}

export function fieldCases(): FieldCase[] {
  const result: FieldCase[] = []
  for (const kind of ["event", "compact", "receipt", "metadata"] as const) {
    const schema = modelValueSchema(kind)
    const alternatives = schema.oneOf ?? schema.anyOf ?? [schema]
    for (const alternative of alternatives) {
      const fixture = example(alternative)
      const type = alternative.properties?.type?.enum
      for (const tag of type ?? [undefined]) {
        const value = structuredClone(fixture)
        if (tag !== undefined) (value as Record<string, RemoteJson>).type = tag
        if (!matches(value, schema)) throw new Error(`Invalid ${kind} fixture`)
        const refs = variableRefs(value, schema)
        for (const ref of refs) {
          const isolated = isolate(schema, value, ref)
          const label = `${kind}:${tag ?? (value as Record<string, RemoteJson>).ok ?? "value"}:${ref.path.join(".")}${ref.key ? "(key)" : ""}`
          result.push({ name: label, kind, fixtureJson: JSON.stringify(isolated.value), ref: isolated.ref })
        }
      }
    }
  }
  return result
}

export function inject(field: FieldCase, text: string): ModelOutboundItem {
  // These generated fixtures are plain JSON (no accounting sidecars or hooks).
  const value = JSON.parse(field.fixtureJson) as RemoteJson
  if (!field.ref.path.length) throw new Error("Expected a variable field inside a model DTO")
  let parent = value as Record<string | number, RemoteJson>
  for (const segment of field.ref.path.slice(0, -1)) parent = parent[segment] as typeof parent
  const last = field.ref.path.at(-1)!
  if (field.ref.key) {
    const child = parent[last]!
    delete parent[last]
    parent[text] = child
  } else parent[last] = text
  return { kind: field.kind, value } as ModelOutboundItem
}
