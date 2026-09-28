import type { JSONSchema } from "@amira/ai"

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v

function matches(expected: unknown, v: unknown): boolean {
  const types = Array.isArray(expected) ? expected : [expected]
  const actual = typeOf(v)
  return types.some((t) => t === actual || (t === "number" && actual === "integer"))
}

/**
 * A deliberately shallow check of tool arguments against the top level of a JSON
 * schema: required keys and primitive types. Returns a message for the model, or
 * undefined when the arguments look fine.
 */
export function checkArgs(schema: JSONSchema, args: Record<string, unknown>): string | undefined {
  if (schema.type !== undefined && schema.type !== "object") return undefined
  const problems: string[] = []
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  for (const key of required) {
    if (args[key] === undefined) problems.push(`missing required parameter "${key}"`)
  }
  const props = (schema.properties ?? {}) as Record<string, { type?: unknown }>
  for (const [key, value] of Object.entries(args)) {
    const expected = props[key]?.type
    if (expected === undefined || value === undefined) continue
    if (!matches(expected, value)) {
      problems.push(`parameter "${key}" should be ${JSON.stringify(expected)}, got ${typeOf(value)}`)
    }
  }
  return problems.length ? problems.join("; ") : undefined
}
