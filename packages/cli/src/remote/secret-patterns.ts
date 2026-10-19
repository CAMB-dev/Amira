import { modelNumericForms } from "./model-numeric-forms.ts"

export interface SecretPatterns {
  readonly values: readonly string[]
  readonly holdback: number
  readonly numeric: ReadonlySet<number>
  contains(text: string): boolean
  representations(value: number): readonly string[]
}
interface Cached {
  source: readonly string[]
  patterns: SecretPatterns
}
const cache = new WeakMap<readonly string[], Cached>()

function numericRepresentations(values: readonly string[]): (value: number) => readonly string[] {
  let fragments: Map<number, Set<string>> | undefined
  const rendered = new Map<number, readonly string[]>()
  return (value) => {
    const cached = rendered.get(value)
    if (cached) return cached
    if (!fragments) {
      const compiled = new Map<number, Set<string>>()
      let work = 0
      const runs = new Set(
        values.flatMap((secret) => secret.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? []),
      )
      for (const run of runs) {
        for (let start = 0; start < run.length; start++) {
          for (let end = start + 1; end <= run.length; end++) {
            if (++work > 100_000) throw new Error("Credential numeric representation limit exceeded")
            const part = run.slice(start, end)
            if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(part)) continue
            const number = Number(part)
            if (!Number.isFinite(number)) continue
            const forms = compiled.get(number) ?? new Set<string>()
            forms.add(part)
            compiled.set(number, forms)
          }
        }
      }
      fragments = compiled
    }
    const forms = Object.freeze([...new Set([...modelNumericForms(value), ...(fragments.get(value) ?? [])])])
    if (rendered.size >= 4096) rendered.delete(rendered.keys().next().value!)
    rendered.set(value, forms)
    return forms
  }
}

/** Compile the already-expanded local snapshot once; mutable callers cannot stale the cache. */
export function secretPatterns(input: readonly string[]): SecretPatterns {
  const cached = cache.get(input)
  if (
    cached &&
    (cached.source === input ||
      (cached.source.length === input.length &&
        cached.source.every((value, index) => value === input[index])))
  )
    return cached.patterns
  const source = Object.freeze([...input])
  const values = Object.freeze([...new Set(source.filter(Boolean))].sort((a, b) => b.length - a.length))
  const pattern = values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  const literal = pattern.length && pattern.length < 256 * 1024 ? new RegExp(pattern) : undefined
  const patterns: SecretPatterns = Object.freeze({
    values,
    holdback: Math.max(0, ...values.map((value) => value.length - 1)),
    numeric: new Set(
      values
        .filter((value) => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value))
        .map(Number)
        .filter(Number.isFinite),
    ),
    contains: (text: string) => (literal ? literal.test(text) : values.some((value) => text.includes(value))),
    representations: numericRepresentations(values),
  })
  cache.set(input, { source, patterns })
  cache.set(values, { source: values, patterns })
  return patterns
}
