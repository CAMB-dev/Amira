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

/** What a `$ref` becomes when it cannot be inlined: external, missing, or recursive. */
const REF_FALLBACK: JSONSchema = { type: "object" }

interface Ctx {
  root: Record<string, unknown>
  /** Refs being inlined, to stop at recursion. */
  refs: string[]
}

type Raw = Record<string, unknown>

/**
 * Reduces a JSON Schema to what Gemini function declarations accept: unknown keys such as
 * `$schema` and `additionalProperties` go, `const` becomes a one-value enum, a
 * `["x", "null"]` type becomes `nullable`, and `required` only names real properties.
 * Local `$ref`s are inlined (a recursive, external or missing one becomes a plain object),
 * `oneOf` is sent as `anyOf`, and `allOf` members are merged into one schema.
 */
export function toGeminiSchema(schema: unknown): JSONSchema | undefined {
  if (!isObject(schema)) return undefined
  return sanitize(schema, { root: schema, refs: [] })
}

function sanitize(s: Raw, ctx: Ctx): JSONSchema {
  if (typeof s.$ref === "string") return inlineRef(s, s.$ref, ctx)
  if (Array.isArray(s.allOf)) return mergeAllOf(s, s.allOf, ctx)
  const out: JSONSchema = {}
  for (const [key, value] of Object.entries(s)) {
    if (key === "oneOf" && !("anyOf" in s)) {
      const options = variants(value, ctx)
      if (options.length) out.anyOf = options
    }
    if (!KEPT.has(key)) continue
    if (key === "properties") {
      const props = properties(value, ctx)
      if (props) out.properties = props
    } else if (key === "items") {
      if (isObject(value)) out.items = sanitize(value, ctx)
    } else if (key === "anyOf") {
      const options = variants(value, ctx)
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
  return withRequired(out, Array.isArray(s.required) ? s.required : [])
}

/** Inlines a local ref; the referring node's own keys, such as a description, win. */
function inlineRef(s: Raw, ref: string, ctx: Ctx): JSONSchema {
  const { $ref: _, ...rest } = s
  const target = ctx.refs.includes(ref) ? undefined : resolve(ctx.root, ref)
  if (!target) return { ...REF_FALLBACK, ...sanitize(rest, ctx) }
  ctx.refs.push(ref)
  try {
    return sanitize({ ...target, ...rest }, ctx)
  } finally {
    ctx.refs.pop()
  }
}

/** Merges `allOf` members: properties and required are joined, other keys go to the first. */
function mergeAllOf(s: Raw, members: unknown[], ctx: Ctx): JSONSchema {
  const { allOf: _, ...rest } = s
  const raws = [rest, ...members.filter(isObject)]
  const out: JSONSchema = {}
  const props: Record<string, JSONSchema> = {}
  // Raw names count too, since one member may require a property another defines.
  const required: unknown[] = []
  for (const raw of raws) {
    const part = sanitize(raw, ctx)
    if (Array.isArray(raw.required)) required.push(...raw.required)
    for (const [key, value] of Object.entries(part)) {
      if (key === "properties") Object.assign(props, value)
      else if (key === "required") required.push(...(value as unknown[]))
      else if (!(key in out)) out[key] = value
    }
  }
  if (Object.keys(props).length) {
    out.properties = props
    if (!out.type) out.type = "object"
  }
  return withRequired(out, [...new Set(required)])
}

function variants(value: unknown, ctx: Ctx): JSONSchema[] {
  return Array.isArray(value) ? value.filter(isObject).map((v) => sanitize(v, ctx)) : []
}

function properties(value: unknown, ctx: Ctx): Record<string, JSONSchema> | undefined {
  if (!isObject(value)) return undefined
  const out: Record<string, JSONSchema> = {}
  for (const [name, prop] of Object.entries(value)) out[name] = isObject(prop) ? sanitize(prop, ctx) : {}
  return Object.keys(out).length ? out : undefined
}

/** Keeps only required names that are real properties. */
function withRequired(out: JSONSchema, required: unknown[]): JSONSchema {
  delete out.required
  const names = Object.keys((out.properties as object | undefined) ?? {})
  const kept = required.filter((r) => typeof r === "string" && names.includes(r))
  if (kept.length) out.required = kept
  return out
}

/** Resolves a local JSON pointer such as `#/$defs/Node`. */
function resolve(root: Raw, ref: string): Raw | undefined {
  if (!ref.startsWith("#")) return undefined
  let node: unknown = root
  for (const raw of ref.slice(1).split("/").filter(Boolean)) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~")
    node = isObject(node) ? node[key] : undefined
  }
  return isObject(node) ? node : undefined
}

function typeOf(value: unknown): JSONSchema {
  if (typeof value === "string") return { type: value }
  if (!Array.isArray(value)) return {}
  const types = value.filter((t) => typeof t === "string" && t !== "null")
  const out: JSONSchema = types.length ? { type: types[0] } : {}
  if (value.includes("null")) out.nullable = true
  return out
}

function isObject(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
