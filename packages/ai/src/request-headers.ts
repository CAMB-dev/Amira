/** Plain request headers, with provider overrides replacing defaults regardless of case. */
export function requestHeaders(
  defaults: Record<string, string>,
  overrides?: Record<string, string>,
  userAgent?: string,
): Record<string, string> {
  const out: Record<string, string> = { ...defaults }
  if (userAgent !== undefined) out["user-agent"] = userAgent
  for (const [name, value] of Object.entries(overrides ?? {})) {
    const lower = name.toLowerCase()
    for (const key of Object.keys(out)) {
      if (key.toLowerCase() === lower) delete out[key]
    }
    out[lower === "user-agent" ? lower : name] = value
  }
  return out
}
