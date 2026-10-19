/** Expand local credential facts once, before any outbound value is redacted or audited. */
export function secretVariants(raw: readonly string[], headerValues: readonly string[]): readonly string[] {
  const facts = new Set(raw.filter(Boolean))
  const decoded = (value: string) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  for (const value of raw) facts.add(decoded(value))
  for (const value of headerValues) {
    for (const form of new Set([value, decoded(value)])) {
      const forms = new Set([form])
      try {
        // Fetch trims HTTP whitespace differently from String.trim (e.g. non-breaking space).
        forms.add(new Headers({ "x-local-credential": form }).get("x-local-credential")!)
      } catch {
        // Invalid HTTP values still have raw facts; a request cannot send them as-is.
      }
      // Conservatively cover intermediaries that also fold internal HTTP whitespace.
      for (const item of [...forms]) forms.add(item.replace(/[ \t\r\n]+/g, " ").replace(/^ +| +$/g, ""))
      for (const item of forms) {
        facts.add(item)
        const token = /^(?:Bearer|Basic|Token)\s+(.+)$/i.exec(item)?.[1]
        if (token) facts.add(token)
      }
    }
  }
  for (const value of [...facts]) {
    if (!value) continue
    facts.add(encodeURIComponent(value))
    facts.add(Buffer.from(value).toString("base64"))
    facts.add(JSON.stringify(value).slice(1, -1))
  }
  return Object.freeze([...facts].filter(Boolean))
}
