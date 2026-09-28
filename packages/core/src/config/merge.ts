export type PlainObject = Record<string, unknown>

export function isPlainObject(v: unknown): v is PlainObject {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Merges `over` onto `base`: objects merge key by key, everything else (arrays too) is replaced. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlainObject(over)) return (over === undefined ? base : over) as T
  const out: PlainObject = isPlainObject(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) out[k] = deepMerge(out[k], v)
  }
  return out as T
}
