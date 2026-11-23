export type PlainObject = Record<string, unknown>

export function isPlainObject(v: unknown): v is PlainObject {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Keys that would reach an object's prototype when assigned; never merged. */
export const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

/** Merges `over` onto `base`: objects merge key by key, everything else (arrays too) is replaced. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlainObject(over)) return (over === undefined ? base : over) as T
  const out: PlainObject = isPlainObject(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined && !UNSAFE_KEYS.has(k)) out[k] = deepMerge(out[k], v)
  }
  return out as T
}
