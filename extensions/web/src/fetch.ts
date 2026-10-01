import { guardedFetch, NetError, parseHttpUrl, type Resolver, readCapped } from "@amira/api"
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

/** A request failure the model should see as is. */
export class FetchError extends Error {}

/** Checks a URL the model gave; plain http(s) only. */
export function parseUrl(raw: string): URL {
  try {
    return parseHttpUrl(raw)
  } catch (err) {
    throw new FetchError((err as Error).message)
  }
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

/**
 * The charset an HTML page declares in its first bytes (BOM or <meta>), for when the
 * Content-Type header names none.
 */
function sniffCharset(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8"
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be"
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le"
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096))
  return (
    /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i.exec(head)?.[1]
  )
}

type Kind = "html" | "json" | "text" | "pdf" | "binary"

/** What the Content-Type header says; undefined when it says nothing useful. */
function headerKind(contentType: string): Kind | undefined {
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
  return undefined
}

function kindOf(contentType: string, bytes: Uint8Array): Kind {
  const byHeader = headerKind(contentType)
  if (byHeader) return byHeader
  // No usable type: look at the bytes.
  const head = bytes.subarray(0, 1024)
  if (new TextDecoder().decode(head.subarray(0, 5)) === "%PDF-") return "pdf"
  if (head.includes(0)) return "binary"
  return /<html|<!doctype html/i.test(new TextDecoder().decode(head)) ? "html" : "text"
}

function unreadable(kind: "pdf" | "binary", url: URL, contentType: string): FetchError {
  return kind === "pdf"
    ? new FetchError(`${url.href} is a PDF; web_fetch cannot extract text from PDFs yet`)
    : new FetchError(`${url.href} is ${contentType || "binary data"}, which web_fetch cannot read as text`)
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
  const timeout = AbortSignal.timeout(opts.timeoutMs)
  const all = AbortSignal.any([signal, timeout])
  const start = parseUrl(raw)
  let url = start
  try {
    const got = await guardedFetch(
      start,
      {
        allowPrivateNetwork: opts.allowPrivateNetwork,
        privateHint: "set web.fetch.allowPrivateNetwork in your user settings to allow",
        headers: {
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "accept-language": "en-US,en;q=0.9",
        },
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.resolve ? { resolve: opts.resolve } : {}),
      },
      all,
    )
    const res = got.response
    url = got.url
    const contentType = res.headers.get("content-type") ?? ""
    const declared = headerKind(contentType)
    if (res.ok && (declared === "pdf" || declared === "binary")) {
      await res.body?.cancel().catch(() => {})
      throw unreadable(declared, url, contentType)
    }
    const { bytes, truncated } = await readCapped(res, opts.maxBytes)
    if (!res.ok) {
      const snippet = decode(bytes.subarray(0, 2000), charsetOf(contentType)).replace(/\s+/g, " ").trim()
      throw new FetchError(
        `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""} from ${url.href}${snippet ? `: ${snippet.slice(0, 300)}` : ""}`,
      )
    }
    const kind = kindOf(contentType, bytes)
    if (kind === "pdf" || kind === "binary") throw unreadable(kind, url, contentType)
    const charset = charsetOf(contentType) ?? (kind === "html" ? sniffCharset(bytes) : undefined)
    const body = decode(bytes, charset)
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
    if (err instanceof NetError) throw new FetchError(err.message)
    throw new FetchError(`fetching ${url.href} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Converted pages by URL, kept for 15 minutes so paging through one does not refetch it. */
export class PageCache {
  #entries = new Map<string, { page: Page; at: number }>()
  #chars = 0
  constructor(
    readonly ttlMs = 15 * 60_000,
    readonly maxEntries = 50,
    readonly now: () => number = Date.now,
    /** Total text kept, in characters; the oldest pages go first. */
    readonly maxChars = 10_000_000,
  ) {}

  #delete(url: string): void {
    const hit = this.#entries.get(url)
    if (!hit) return
    this.#chars -= hit.page.text.length
    this.#entries.delete(url)
  }

  get(url: string): Page | undefined {
    const hit = this.#entries.get(url)
    if (!hit) return undefined
    if (this.now() - hit.at > this.ttlMs) {
      this.#delete(url)
      return undefined
    }
    return hit.page
  }

  set(url: string, page: Page): void {
    this.#delete(url)
    if (page.text.length > this.maxChars) return
    this.#entries.set(url, { page, at: this.now() })
    this.#chars += page.text.length
    while (this.#entries.size > this.maxEntries || this.#chars > this.maxChars) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#delete(oldest)
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
