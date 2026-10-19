import { transferUsageAccounting } from "@amira/ai/accounting"
import { secretPatterns } from "./secret-patterns.ts"

/** Keep block boundaries and mask replacement joins; the first fragment may already be public. */
export function maskModelFragments(input: string[], secrets: readonly string[], committed = 0): string[] {
  let parts = input
  while (true) {
    const text = parts.join("")
    if (!text || !secrets.length || !secretPatterns(secrets).contains(text)) return parts
    const spans: { start: number; end: number }[] = []
    for (const secret of secrets) {
      if (!secret) continue
      let start = text.indexOf(secret)
      while (start !== -1) {
        // Published material cannot be changed. Only its continuation may be suppressed.
        if (start + secret.length <= committed) throw new Error("Unsafe published model suffix")
        spans.push({ start: Math.max(start, committed), end: start + secret.length })
        start = text.indexOf(secret, start + 1)
      }
    }
    if (!spans.length) return parts
    spans.sort((a, b) => a.start - b.start || b.end - a.end)
    const merged: typeof spans = []
    for (const span of spans) {
      const last = merged.at(-1)
      if (last && span.start < last.end) last.end = Math.max(last.end, span.end)
      else merged.push({ ...span })
    }
    let offset = 0
    parts = parts.map((part) => {
      const start = offset
      offset += part.length
      const end = offset
      if (end <= committed) return part
      let result = "",
        cursor = start
      for (const span of merged) {
        if (span.end <= start || span.start >= end) continue
        result += text.slice(cursor, Math.max(cursor, span.start))
        if (span.start >= start && !secrets.some((secret) => "[redacted]".includes(secret)))
          result += "[redacted]"
        cursor = Math.min(end, span.end)
      }
      return result + text.slice(cursor, end)
    })
  }
}

/** Per-field masks complement the chronological filter; usage keeps its private accounting. */
export function redactModelValue<T>(value: T, secrets: readonly string[]): T {
  const sorted = secretPatterns(secrets).values
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return maskModelFragments([item], sorted)[0]
    if (Array.isArray(item)) return item.map(visit)
    if (!item || typeof item !== "object") return item
    const result: Record<string, unknown> = Object.create(null)
    for (const [key, child] of Object.entries(item)) {
      const name = maskModelFragments([key], sorted)[0]!
      if (Object.hasOwn(result, name)) throw new Error("Model redaction key collision")
      Object.defineProperty(result, name, {
        value: visit(child),
        enumerable: true,
        writable: true,
        configurable: true,
      })
      if (key === "usage" && child && typeof child === "object" && !Array.isArray(child) && "input" in child)
        transferUsageAccounting(
          child as Parameters<typeof transferUsageAccounting>[0],
          result[name] as Parameters<typeof transferUsageAccounting>[1],
        )
    }
    return result
  }
  return visit(value) as T
}
