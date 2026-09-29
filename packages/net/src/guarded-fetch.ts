import { assertPublicHost, dnsResolver, type Resolver } from "./address.ts"

/** A refusal or failure whose message can be shown as it is. */
export class NetError extends Error {}

export const USER_AGENT = "Mozilla/5.0 (compatible; Amira/0.1; +https://github.com/CAMB-dev/Amira)"
const MAX_REDIRECTS = 10

/** Checks a URL: plain http(s) only, without credentials; the fragment is dropped. */
export function parseHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new NetError(`not a valid URL: ${raw}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new NetError(`only http and https URLs can be fetched, got ${url.protocol}`)
  if (url.username || url.password) throw new NetError("URLs with credentials are not fetched")
  url.hash = ""
  return url
}

export interface GuardedFetchOptions {
  /** Skip the private-network check. Default false: such addresses are refused. */
  allowPrivateNetwork?: boolean
  /** Added to the refusal of a private address, e.g. the setting that allows them. */
  privateHint?: string
  headers?: Record<string, string>
  /** For tests: the network and name resolution. */
  fetch?: typeof fetch
  resolve?: Resolver
}

export interface GuardedResponse {
  response: Response
  /** Where the last redirect led. */
  url: URL
}

/**
 * Fetches a URL, following redirects by hand so every hop is checked: a host that is, or
 * resolves to, a loopback, private, link-local or otherwise non-public address is refused
 * (unless `allowPrivateNetwork`), and the request goes to the address that was checked, so a
 * second DNS answer (rebinding) cannot send it elsewhere. Host and TLS server name keep the
 * original name. Refusals and redirect problems throw `NetError`; network errors pass through.
 * The response body is left unread; cancel it when it is not wanted.
 */
export async function guardedFetch(
  start: URL,
  opts: GuardedFetchOptions,
  signal: AbortSignal,
): Promise<GuardedResponse> {
  const doFetch = opts.fetch ?? fetch
  const resolve = opts.resolve ?? dnsResolver
  let url = start
  for (let hop = 0; ; hop++) {
    let target = url
    const headers: Record<string, string> = { "user-agent": USER_AGENT, ...opts.headers }
    let tls: { serverName: string } | undefined
    if (!opts.allowPrivateNetwork) {
      const addresses = await assertPublicHost(url, resolve, signal, opts.privateHint).catch((err: Error) => {
        throw signal.aborted ? err : new NetError(err.message)
      })
      const ip = addresses?.find((a) => !a.includes(":")) ?? addresses?.[0]
      if (ip) {
        target = new URL(url.href)
        target.hostname = ip.includes(":") ? `[${ip}]` : ip
        headers.host = url.host
        if (url.protocol === "https:") tls = { serverName: url.hostname }
      }
    }
    signal.throwIfAborted()
    const response = await doFetch(target.href, {
      redirect: "manual",
      signal,
      headers,
      ...(tls ? { tls } : {}),
    } as RequestInit)
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null
    if (!location) return { response, url }
    await response.body?.cancel().catch(() => {})
    if (hop >= MAX_REDIRECTS) throw new NetError(`too many redirects (more than ${MAX_REDIRECTS})`)
    try {
      url = parseHttpUrl(new URL(location, url).href)
    } catch (err) {
      throw new NetError(`${url.href} redirected to an unusable URL: ${(err as Error).message}`)
    }
  }
}

/** Reads at most `max` bytes of a body, cancelling the rest. */
export async function readCapped(
  res: Response,
  max: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (size + value.byteLength > max) {
        chunks.push(value.subarray(0, max - size))
        size = max
        truncated = true
        break
      }
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.byteLength
  }
  return { bytes, truncated }
}
