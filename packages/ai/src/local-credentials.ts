// Resolved headers can be reused by local probes. Never expand their literal ${...} again.
// Exact substitution facts stay local: they are neither endpoint fields nor serialized metadata.
const headerFacts = new WeakMap<Record<string, string>, readonly string[]>()

export function resolveEndpointHeaders(
  headers: Record<string, string>,
  env: Record<string, string | undefined>,
): Record<string, string> {
  if (headerFacts.has(headers)) return headers
  const facts: string[] = []
  const resolved = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      value.replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
        (_match, variable: string, fallback?: string) => {
          const literal = env[variable] || fallback || ""
          if (literal) facts.push(literal)
          return literal
        },
      ),
    ]),
  )
  headerFacts.set(resolved, Object.freeze(facts))
  return resolved
}

/** Exact local header interpolation literals, not guesses extracted from an assembled header. */
export function resolvedEndpointCredentials(endpoint: {
  headers?: Record<string, string>
}): readonly string[] {
  return endpoint.headers ? (headerFacts.get(endpoint.headers) ?? []) : []
}
