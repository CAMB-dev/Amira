import type { ProviderSettings } from "../settings.ts"

export function maskedEntry(entry: ProviderSettings): ProviderSettings {
  const copy: ProviderSettings = JSON.parse(
    JSON.stringify(entry, (key, value) => (key === "apiKey" ? "••••" : value)),
  )
  if (copy.headers)
    copy.headers = Object.fromEntries(
      Object.entries(copy.headers).map(([name, value]) => [
        name,
        /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) ? value : "••••",
      ]),
    )
  if (copy.baseUrl) {
    try {
      const url = new URL(copy.baseUrl)
      const sensitive = !!(url.username || url.password || url.search || url.hash)
      if (url.username) url.username = "REDACTED"
      if (url.password) url.password = "REDACTED"
      for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, "REDACTED")
      if (url.hash) url.hash = "REDACTED"
      if (sensitive) copy.baseUrl = url.toString()
    } catch {
      copy.baseUrl = "(invalid URL)"
    }
  }
  return copy
}
