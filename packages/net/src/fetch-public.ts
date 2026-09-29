import type { Resolver } from "./address.ts"
import { guardedFetch, NetError, parseHttpUrl, readCapped } from "./guarded-fetch.ts"

export interface PublicFetchOptions {
  /** The most bytes read; a larger body is refused ("too large"). */
  maxBytes: number
  signal: AbortSignal
  /** Sent with the request, e.g. `accept`. */
  headers?: Record<string, string>
  /** Content types taken: others are refused before the body is read. Default any. */
  types?: RegExp
  /** For tests: the network and name resolution. */
  fetch?: typeof fetch
  resolve?: Resolver
}

export interface PublicFetchResult {
  bytes: Uint8Array
  /** The response's Content-Type, "" without one. */
  contentType: string
  /** Where the last redirect led. */
  url: string
}

/**
 * Downloads a URL a reply or a page chose, with web_fetch's protection: plain http(s) without
 * credentials; no loopback, private or link-local address, every redirect checked and the
 * connection pinned to the checked address; a 2xx answer of an accepted type, at most
 * `maxBytes`. Refusals throw NetError with a message that can be shown.
 */
export async function fetchPublic(url: string, opts: PublicFetchOptions): Promise<PublicFetchResult> {
  const { response, url: final } = await guardedFetch(
    parseHttpUrl(url),
    {
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.resolve ? { resolve: opts.resolve } : {}),
    },
    opts.signal,
  )
  const refuse = async (why: string): Promise<never> => {
    await response.body?.cancel().catch(() => {})
    throw new NetError(`${url}: ${why}`)
  }
  if (!response.ok) return refuse(`HTTP ${response.status}`)
  const contentType = response.headers.get("content-type") ?? ""
  if (opts.types && !opts.types.test(contentType))
    return refuse(`not an accepted type (${contentType || "no content type"})`)
  if (Number(response.headers.get("content-length")) > opts.maxBytes) return refuse("too large")
  const { bytes, truncated } = await readCapped(response, opts.maxBytes)
  if (truncated) throw new NetError(`${url}: too large`)
  return { bytes, contentType, url: final.href }
}
