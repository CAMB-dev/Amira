import type { FrontendJson } from "./snapshot.ts"

/** Copy JSON data without invoking toJSON or silently losing unsupported values. */
export function frontendJson(value: unknown, ancestors = new Set<object>()): FrontendJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "object" || !value) throw new TypeError("Frontend data must be finite JSON")
  if (ancestors.has(value)) throw new TypeError("Frontend data must not be circular")
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return Array.from(value, (item) => frontendJson(item, ancestors))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Frontend data must contain only plain objects")
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, frontendJson(item, ancestors)]),
    )
  } finally {
    ancestors.delete(value)
  }
}

export function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeSnapshot(item)
    Object.freeze(value)
  }
  return value
}
