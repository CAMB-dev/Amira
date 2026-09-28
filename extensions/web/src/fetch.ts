import { assertPublicHost, dnsResolver, type Resolver } from "./address.ts"
import { htmlTitle, htmlToMarkdown } from "./html.ts"

export interface FetchOptions {
  maxBytes: number
  timeoutMs: number
  allowPrivateNetwork: boolean
  fetch?: typeof fetch
  resolve?: Resolver
}

export interface Page {
  /** The URL asked for. */
  url: string
  /** Where the last redirect led. */
  finalUrl: string
  status: number
  contentType: string
  title?: string
  /** The page as Markdown (HTML) or text. */
  text: string
  /** The body was longer than maxBytes and was cut. */
  bodyTruncated: boolean
}

export const USER_AGENT = "Mozilla/5.0 (compatible; Amira/0.1; +https://github.com/CAMB-dev/Amira)"
const MAX_REDIRECTS = 10

/** A request failure the model should see as is. */
export class FetchError extends Error {}

/** Checks a URL the model gave; plain http(s) only. */
export function parseUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new FetchError(`not a valid URL: ${raw}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new FetchError(`only http and https URLs can be fetched, got ${url.protocol}`)
  if (url.username || url.password) throw new FetchError("URLs with credentials are not fetched")
  url.hash = ""
  return url
}

function charsetOf(contentType: string): string | undefined {
  return /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1]
}

function decode(bytes: Uint8Array, charset: string | undefined): string {
  try {
    // Any label TextDecoder knows; an unknown one throws and falls back to UTF-8.
    return new TextDecoder((charset ?? "utf-8") as "utf-8").decode(bytes)
  } catch {
    return new TextDecoder("utf-8").decode(bytes)
  }
}

/** Reads at most `max` bytes of a body, cancelling the rest. */
async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
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

type Kind = "html" | "json" | "text" | "pdf" | "binary"

function kindOf(contentType: string, bytes: Uint8Array): Kind {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
  if (type === "text/html" || type === "application/xhtml+xml") return "html"
  if (type === "application/json" || type.endsWith("+json")) return "json"
  if (type === "application/pdf") return "pdf"
  if (
    type.startsWith("text/") ||
    type.endsWith("+xml") ||
    type === "application/xml" ||
    type === "application/javascript" ||
    type === "application/x-ndjson"
  )
    return "text"
  if (type && type !== "application/octet-stream") return "binary"
  // No usable type: look at the bytes.
  const head = bytes.subarray(0, 1024)
  if (new TextDecoder().decode(head.subarray(0, 5)) === "%PDF-") return "pdf"
  if (head.includes(0)) return "binary"
  return /<html|<!doctype html/i.test(new TextDecoder().decode(head)) ? "html" : "text"
}

function toText(kind: Kind, body: string, base: string): string {
  if (kind === "html") return htmlToMarkdown(body, base)
  if (kind === "json") {
    try {
      return JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      return body
    }
  }
  return body
}

/**
 * Fetches a URL, following redirects by hand so every hop is checked against the
 * private-network rule, and converts the body to text.
 */
export async function fetchPage(raw: string, opts: FetchOptions, signal: AbortSignal): Promise<Page> {
  const doFetch = opts.fetch ?? fetch
  const resolve = opts.resolve ?? dnsResolver
  const timeout = AbortSignal.timeout(opts.timeoutMs)
  const all = AbortSignal.any([signal, timeout])
  const start = parseUrl(raw)
  let url = start
  let res: Response
  try {
    for (let hop = 0; ; hop++) {
      if (!opts.allowPrivateNetwork) {
        await assertPublicHost(url, resolve).catch((err: Error) => {
          throw new FetchError(err.message)
        })
      }
      all.throwIfAborted()
      res = await doFetch(url.href, {
        redirect: "manual",
        signal: all,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "accept-language": "en-US,en;q=0.9",
        },
      })
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null
      if (!location) break
      await res.body?.cancel().catch(() => {})
      if (hop >= MAX_REDIRECTS) throw new FetchError(`too many redirects (more than ${MAX_REDIRECTS})`)
      let next: URL
      try {
        next = parseUrl(new URL(location, url).href)
      } catch (err) {
        throw new FetchError(`${url.href} redirected to an unusable URL: ${(err as Error).message}`)
      }
      url = next
    }
    const contentType = res.headers.get("content-type") ?? ""
    const { bytes, truncated } = await readCapped(res, opts.maxBytes)
    if (!res.ok) {
      const snippet = decode(bytes.subarray(0, 2000), charsetOf(contentType)).replace(/\s+/g, " ").trim()
      throw new FetchError(
        `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""} from ${url.href}${snippet ? `: ${snippet.slice(0, 300)}` : ""}`,
      )
    }
    const kind = kindOf(contentType, bytes)
    if (kind === "pdf")
      throw new FetchError(`${url.href} is a PDF; web_fetch cannot extract text from PDFs yet`)
    if (kind === "binary")
      throw new FetchError(
        `${url.href} is ${contentType || "binary data"}, which web_fetch cannot read as text`,
      )
    const body = decode(bytes, charsetOf(contentType))
    const title = kind === "html" ? htmlTitle(body) : undefined
    return {
      url: start.href,
      finalUrl: url.href,
      status: res.status,
      contentType,
      ...(title ? { title } : {}),
      text: toText(kind, body, url.href),
      bodyTruncated: truncated,
    }
  } catch (err) {
    if (signal.aborted) throw signal.reason ?? new Error("aborted")
    if (timeout.aborted) throw new FetchError(`timed out after ${opts.timeoutMs} ms fetching ${url.href}`)
    if (err instanceof FetchError) throw err
    throw new FetchError(`fetching ${url.href} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Converted pages by URL, kept for 15 minutes so paging through one does not refetch it. */
export class PageCache {
  #entries = new Map<string, { page: Page; at: number }>()
  constructor(
    readonly ttlMs = 15 * 60_000,
    readonly maxEntries = 50,
    readonly now: () => number = Date.now,
  ) {}

  get(url: string): Page | undefined {
    const hit = this.#entries.get(url)
    if (!hit) return undefined
    if (this.now() - hit.at > this.ttlMs) {
      this.#entries.delete(url)
      return undefined
    }
    return hit.page
  }

  set(url: string, page: Page): void {
    this.#entries.delete(url)
    this.#entries.set(url, { page, at: this.now() })
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
  }
}

/** Where later passages mention the prompt's words, so the model can page straight to them. */
function promptHits(text: string, prompt: string, from: number, to: number): string[] {
  const words = [...new Set(prompt.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])]
  if (!words.length) return []
  const hits: string[] = []
  let at = 0
  for (const para of text.split("\n\n")) {
    const start = at
    at += para.length + 2
    if (start >= from && start < to) continue
    const lower = para.toLowerCase()
    if (!words.some((w) => lower.includes(w))) continue
    hits.push(`- offset ${start}: ${para.replace(/\s+/g, " ").slice(0, 100)}`)
    if (hits.length >= 5) break
  }
  return hits
}

/** One window of a page, with a header and a marker saying how to read on. */
export function renderPage(page: Page, offset: number, maxChars: number, prompt?: string): string {
  const total = page.text.length
  const from = Math.min(Math.max(0, offset), total)
  const to = Math.min(total, from + maxChars)
  const lines = [`URL: ${page.url}`]
  if (page.finalUrl !== page.url) lines.push(`Redirected to: ${page.finalUrl}`)
  if (page.title) lines.push(`Title: ${page.title}`)
  if (page.contentType) lines.push(`Content-Type: ${page.contentType}`)
  if (page.bodyTruncated) lines.push("Note: the response was larger than the download limit and was cut.")
  if (from > 0 || to < total) lines.push(`Showing characters ${from}-${to} of ${total}.`)
  const body = page.text.slice(from, to)
  const out = [lines.join("\n"), "", body || (total ? "(no text at this offset)" : "(the page has no text)")]
  if (to < total) {
    out.push("", `[Truncated: ${total - to} more characters. Call web_fetch with offset: ${to} to read on.]`)
    const hits = prompt ? promptHits(page.text, prompt, from, to) : []
    if (hits.length) out.push("Passages elsewhere mentioning your prompt:", ...hits)
  }
  return out.join("\n")
}
