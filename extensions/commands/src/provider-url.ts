/** Presentation only: endpoint controls keep the original URL for provider administration. */
export function safeProviderUrl(baseUrl: string, options: { originOnly?: boolean } = {}): string {
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== "https:" && url.protocol !== "http:") return "(invalid endpoint)"
    if (options.originOnly) return url.origin
    // Validate with URL, but edit the original text: reconstruction changes host case,
    // default ports, path segments and benign query encoding. Reject ambiguous spellings.
    if (/[\p{Cc}\\]/u.test(baseUrl)) return "(invalid endpoint)"
    const fragment = baseUrl.indexOf("#")
    const visible = fragment < 0 ? baseUrl : baseUrl.slice(0, fragment)
    const parts = /^(https?:\/\/)([^/?#\\]+)/i.exec(visible)
    if (!parts) return "(invalid endpoint)"
    const authority = parts[2]!
    const prefix = parts[1]! + authority.slice(authority.lastIndexOf("@") + 1)
    const tail = visible.slice(parts[0].length)
    const query = tail.indexOf("?")
    if (query < 0) return prefix + tail
    const parameters = tail
      .slice(query + 1)
      .split("&")
      .filter((parameter) => {
        const key = new URLSearchParams(parameter).keys().next().value ?? ""
        const name = key.replace(/[^a-z0-9]/gi, "")
        return !(
          /key|token|secret|pass(?:word|wd)?|auth|credential|signature|session|cookie|bearer/i.test(name) ||
          /^(?:sig|code|jwt)$/i.test(name)
        )
      })
    return prefix + tail.slice(0, query) + (parameters.length ? `?${parameters.join("&")}` : "")
  } catch {
    // Never echo an unparseable endpoint: it can still contain credential text.
    return "(invalid endpoint)"
  }
}
