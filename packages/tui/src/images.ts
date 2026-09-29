import { guardedFetch, NetError, parseHttpUrl, type Resolver, readCapped } from "@amira/net"
import type { RemoteImageFetch } from "@amira/tui-kit"

/** Types the terminal protocols can show; the loader checks the file's signature too. */
const IMAGE_TYPE = /^image\/(png|jpeg|jpg|gif|webp)\b/i

/**
 * Fetches images for Markdown replies with the protection web_fetch has: no local or
 * private-network addresses (every redirect checked, the connection pinned to the checked
 * address), only image content types, at most `maxBytes`.
 */
export function remoteImageFetch(opts: { fetch?: typeof fetch; resolve?: Resolver } = {}): RemoteImageFetch {
  return async (url, { maxBytes, signal }) => {
    // Plain http(s) only, without credentials, as web_fetch takes them.
    const { response } = await guardedFetch(
      parseHttpUrl(url.href),
      {
        headers: { accept: "image/png,image/jpeg,image/gif,image/webp;q=0.9" },
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.resolve ? { resolve: opts.resolve } : {}),
      },
      signal,
    )
    const refuse = async (why: string) => {
      await response.body?.cancel().catch(() => {})
      throw new NetError(`${url.href}: ${why}`)
    }
    if (!response.ok) return refuse(`HTTP ${response.status}`)
    const contentType = response.headers.get("content-type") ?? ""
    if (!IMAGE_TYPE.test(contentType)) return refuse(`not an image (${contentType || "no content type"})`)
    if (Number(response.headers.get("content-length")) > maxBytes) return refuse("too large")
    const { bytes, truncated } = await readCapped(response, maxBytes)
    if (truncated) throw new NetError(`${url.href}: too large`)
    return { bytes, contentType }
  }
}
