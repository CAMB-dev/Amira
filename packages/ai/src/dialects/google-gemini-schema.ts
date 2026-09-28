import type { JSONSchema } from "../types.ts"

/** Schema keys Gemini's OpenAPI subset accepts. Everything else is dropped. */
const KEPT = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "items",
  "minItems",
  "maxItems",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "anyOf",
  "propertyOrdering",
  "default",
  "example",
])

/**
 * Reduces a JSON Schema to what Gemini function declarations accept: unknown keys such as
 * `$schema` and `additionalProperties` go, `const` becomes a one-value enum, a
 * `["x", "null"]` type becomes `nullable`, and `required` only names real properties.
 */
export function toGeminiSchema(schema: unknown): JSONSchema | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined
  const s = schema as Record<string, unknown>
  const out: JSONSchema = {}
  for (const [key, value] of Object.entries(s)) {
    if (!KEPT.has(key)) continue
    if (key === "properties") {
      const props = properties(value)
      if (props) out.properties = props
    } else if (key === "items") {
      const items = toGeminiSchema(value)
      if (items) out.items = items
    } else if (key === "anyOf") {
      const options = Array.isArray(value) ? value.map(toGeminiSchema).filter((v) => v !== undefined) : []
      if (options.length) out.anyOf = options
    } else if (key === "type") {
      Object.assign(out, typeOf(value))
    } else if (key === "enum") {
      // Gemini enums are strings only.
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) out.enum = value
    } else {
      out[key] = value
    }
  }
  if (typeof s.const === "string" && !out.enum) out.enum = [s.const]
  if (Array.isArray(out.required)) {
    const names = Object.keys((out.properties as object | undefined) ?? {})
    const required = out.required.filter((r) => typeof r === "string" && names.includes(r))
    if (required.length) out.required = required
    else delete out.required
  }
  return out
}

function properties(value: unknown): Record<string, JSONSchema> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, JSONSchema> = {}
  for (const [name, prop] of Object.entries(value)) out[name] = toGeminiSchema(prop) ?? {}
  return Object.keys(out).length ? out : undefined
}

function typeOf(value: unknown): JSONSchema {
  if (typeof value === "string") return { type: value }
  if (!Array.isArray(value)) return {}
  const types = value.filter((t) => typeof t === "string" && t !== "null")
  const out: JSONSchema = types.length ? { type: types[0] } : {}
  if (value.includes("null")) out.nullable = true
  return out
}
