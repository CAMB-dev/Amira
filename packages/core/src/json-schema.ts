import type { JSONSchema } from "@amira/ai"

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v

function typeMatches(expected: unknown, v: unknown): boolean {
  const types = Array.isArray(expected) ? expected : [expected]
  const actual = typeOf(v)
  return types.some((t) => t === actual || (t === "number" && actual === "integer"))
}

const MAX_PROBLEMS = 10

/**
 * Checks a value against a JSON Schema, for structured results (SpawnOptions.schema). Covers
 * the keywords models are asked to follow: type, enum, const, properties, required,
 * additionalProperties, items, the length, size and range limits, pattern, and allOf, anyOf
 * and oneOf. Others (such as $ref and format) are not checked. Returns the problems found,
 * each naming where it is (`value.items[2].name`); none means the value fits.
 */
export function validateValue(schema: JSONSchema, value: unknown, at = "value"): string[] {
  const problems: string[] = []
  check(schema, value, at, problems)
  return problems.slice(0, MAX_PROBLEMS)
}

function check(schema: JSONSchema, v: unknown, at: string, out: string[]): void {
  if (out.length >= MAX_PROBLEMS || typeof schema !== "object" || schema === null) return
  const s = schema as Record<string, unknown>
  if (s.type !== undefined && !typeMatches(s.type, v)) {
    out.push(`${at} should be ${Array.isArray(s.type) ? s.type.join(" or ") : String(s.type)}, got ${typeOf(v)}`)
    return
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => same(e, v))) {
    out.push(`${at} should be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`)
  }
  if ("const" in s && !same(s.const, v)) out.push(`${at} should be ${JSON.stringify(s.const)}`)

  if (typeof v === "string") {
    if (typeof s.minLength === "number" && [...v].length < s.minLength)
      out.push(`${at} should have at least ${s.minLength} characters`)
    if (typeof s.maxLength === "number" && [...v].length > s.maxLength)
      out.push(`${at} should have at most ${s.maxLength} characters`)
    if (typeof s.pattern === "string") {
      try {
        if (!new RegExp(s.pattern, "u").test(v)) out.push(`${at} should match /${s.pattern}/`)
      } catch {
        // A pattern JavaScript cannot compile is not the model's fault.
      }
    }
  }
  if (typeof v === "number") {
    if (typeof s.minimum === "number" && v < s.minimum) out.push(`${at} should be at least ${s.minimum}`)
    if (typeof s.maximum === "number" && v > s.maximum) out.push(`${at} should be at most ${s.maximum}`)
    if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum)
      out.push(`${at} should be more than ${s.exclusiveMinimum}`)
    if (typeof s.exclusiveMaximum === "number" && v >= s.exclusiveMaximum)
      out.push(`${at} should be less than ${s.exclusiveMaximum}`)
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === "number" && v.length < s.minItems)
      out.push(`${at} should have at least ${s.minItems} items`)
    if (typeof s.maxItems === "number" && v.length > s.maxItems)
      out.push(`${at} should have at most ${s.maxItems} items`)
    if (s.items && typeof s.items === "object" && !Array.isArray(s.items)) {
      for (const [i, item] of v.entries()) check(s.items as JSONSchema, item, `${at}[${i}]`, out)
    }
  }
  if (typeOf(v) === "object") {
    const obj = v as Record<string, unknown>
    const props = (s.properties && typeof s.properties === "object" ? s.properties : {}) as Record<
      string,
      JSONSchema
    >
    if (Array.isArray(s.required)) {
      for (const key of s.required as string[]) {
        if (obj[key] === undefined) out.push(`${at} is missing "${key}"`)
      }
    }
    for (const [key, item] of Object.entries(obj)) {
      if (item === undefined) continue
      const where = /^[A-Za-z_$][\w$]*$/.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`
      const prop = props[key]
      if (prop) check(prop, item, where, out)
      else if (s.additionalProperties === false) out.push(`${at} has an unexpected property "${key}"`)
      else if (s.additionalProperties && typeof s.additionalProperties === "object")
        check(s.additionalProperties as JSONSchema, item, where, out)
    }
  }

  if (Array.isArray(s.allOf)) for (const sub of s.allOf) check(sub as JSONSchema, v, at, out)
  if (Array.isArray(s.anyOf) && !s.anyOf.some((sub) => validateValue(sub as JSONSchema, v, at).length === 0)) {
    out.push(`${at} matches none of the allowed shapes (${firstProblem(s.anyOf as JSONSchema[], v, at)})`)
  }
  if (Array.isArray(s.oneOf)) {
    const fits = s.oneOf.filter((sub) => validateValue(sub as JSONSchema, v, at).length === 0).length
    if (fits === 0)
      out.push(`${at} matches none of the allowed shapes (${firstProblem(s.oneOf as JSONSchema[], v, at)})`)
    else if (fits > 1) out.push(`${at} matches more than one of the allowed shapes`)
  }
}

function firstProblem(options: JSONSchema[], v: unknown, at: string): string {
  return options.map((o) => validateValue(o, v, at)[0]).find(Boolean) ?? "no match"
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
