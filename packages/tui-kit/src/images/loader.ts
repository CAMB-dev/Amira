import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ImageSupport } from "../capabilities.ts"
import { imageSize } from "./decode.ts"
import { canShow, encodeImage, type ImageBlock } from "./encode.ts"

/** Fetches an image over the network: its bytes (at most `maxBytes`) and Content-Type. */
export type RemoteImageFetch = (
  url: URL,
  opts: { maxBytes: number; signal: AbortSignal },
) => Promise<{ bytes: Uint8Array; contentType: string }>

export interface ImageLoaderOptions {
  support: ImageSupport
  /** Relative paths are found from here: the directory, or where to ask for it. */
  cwd: string | (() => string)
  /** How http(s) images are fetched; without it they are not shown. */
  fetchRemote?: RemoteImageFetch
  /** Largest file read or downloaded. Default 10 MB. */
  maxBytes?: number
  /** Time a download may take. Default 10 s. */
  timeoutMs?: number
  /** The most rows an image may take, asked each time (the terminal's height changes). */
  maxRows: () => number
  /** Encoded images kept, in characters of their sequences. Default 64 M. */
  cacheChars?: number
}

const MB = 1024 * 1024
/** Results kept at most, failures included (they weigh nothing in characters). */
const MAX_ENTRIES = 500

/** Content types that are images this can show (the signature is checked as well). */
const IMAGE_TYPES = /^image\/(png|jpeg|jpg|gif|webp)\b/i
const REMOTE = /^https?:\/\//i

/**
 * Loads the images a Markdown reply shows, for one session: from local files (relative to the
 * working directory, or absolute) and http(s) URLs (through `fetchRemote`), checks they are a
 * PNG, JPEG, GIF or WebP that the protocol can show, and encodes them to fit. Results are cached
 * by source and size, failures too, so an image shown again costs nothing.
 */
export class ImageLoader {
  readonly timeoutMs: number
  private readonly maxBytes: number
  private cache = new Map<string, Promise<ImageBlock | undefined>>()
  /** Sizes of the cached sequences, oldest first, for dropping the oldest past the limits. */
  private sizes = new Map<string, number>()
  private chars = 0
  private files = new Map<string, Promise<Uint8Array>>()

  constructor(private opts: ImageLoaderOptions) {
    this.maxBytes = opts.maxBytes ?? 10 * MB
    this.timeoutMs = opts.timeoutMs ?? 10_000
  }

  /** The image at `src`, fitted to `maxCols` columns; undefined when it cannot be shown. */
  load(src: string, maxCols: number): Promise<ImageBlock | undefined> {
    const maxRows = this.opts.maxRows()
    const remote = REMOTE.test(src)
    // A local file by where it is now: the working directory may change.
    const cwd = this.opts.cwd
    const source = remote ? src : localPath(src, typeof cwd === "string" ? cwd : cwd())
    if (source === undefined) return Promise.resolve(undefined)
    const key = `${maxCols}x${maxRows} ${source}`
    let hit = this.cache.get(key)
    if (hit) {
      // Used again: it becomes the newest.
      const size = this.sizes.get(key)
      if (size !== undefined) {
        this.sizes.delete(key)
        this.sizes.set(key, size)
      }
      return hit
    }
    hit = this.encode(source, remote, maxCols, maxRows).then(
      (block) => {
        this.remember(key, block?.seq.length ?? 0)
        return block
      },
      () => {
        this.remember(key, 0)
        return undefined
      },
    )
    this.cache.set(key, hit)
    return hit
  }

  private remember(key: string, size: number) {
    if (!this.cache.has(key)) return
    this.sizes.set(key, size)
    this.chars += size
    const limit = this.opts.cacheChars ?? 64 * MB
    for (const [k, n] of this.sizes) {
      if (this.chars <= limit && this.sizes.size <= MAX_ENTRIES) break
      this.sizes.delete(k)
      this.cache.delete(k)
      this.chars -= n
    }
  }

  private async encode(
    source: string,
    remote: boolean,
    maxCols: number,
    maxRows: number,
  ): Promise<ImageBlock | undefined> {
    const bytes = await this.bytes(source, remote)
    const size = imageSize(bytes)
    if (!size || !canShow(this.opts.support.protocol, size.format)) return undefined
    // Decoding is synchronous: let the frame that shows the fallback be drawn first.
    await new Promise((r) => setTimeout(r, 0))
    return encodeImage(bytes, {
      protocol: this.opts.support.protocol,
      maxCols,
      maxRows,
      cell: this.opts.support.cell,
    })
  }

  /** The file's bytes, read or downloaded once however many sizes it is shown at. */
  private bytes(source: string, remote: boolean): Promise<Uint8Array> {
    let hit = this.files.get(source)
    if (!hit) {
      hit = remote ? this.download(source) : this.read(source)
      this.files.set(source, hit)
      // Only while in flight: the encoded images are what is kept.
      const done = () => this.files.delete(source)
      hit.then(done, done)
    }
    return hit
  }

  private async download(url: string): Promise<Uint8Array> {
    if (!this.opts.fetchRemote) throw new Error("remote images are not fetched")
    const { bytes, contentType } = await this.opts.fetchRemote(new URL(url), {
      maxBytes: this.maxBytes,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!IMAGE_TYPES.test(contentType)) throw new Error(`not an image: ${contentType || "no content type"}`)
    return bytes
  }

  private async read(path: string): Promise<Uint8Array> {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`not a file: ${path}`)
    if (info.size > this.maxBytes) throw new Error(`image too large: ${info.size} bytes`)
    return new Uint8Array(await readFile(path))
  }
}

/** A path that goes to another machine: \\host\share, //host/share, \\?\UNC\..., \\.\device. */
const NETWORK_PATH = /^[\\/]{2}/

/**
 * Where a local image is: a file: URL on this machine, or a path (percent-escapes decoded) from
 * `cwd`. Never a network path: opening one has Windows connect to that host with the user's
 * credentials, before anything could tell it is not an image.
 */
export function localPath(src: string, cwd: string): string | undefined {
  let path: string
  if (/^file:/i.test(src)) {
    try {
      const url = new URL(src)
      if (url.host !== "" && url.host.toLowerCase() !== "localhost") return undefined
      path = fileURLToPath(url)
    } catch {
      return undefined
    }
  } else {
    // Another scheme (data:, ftp:, ...), but not a Windows drive letter.
    if (/^[a-z][a-z0-9+.-]+:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return undefined
    path = src
    try {
      path = decodeURI(src)
    } catch {}
  }
  if (NETWORK_PATH.test(path) || NT_PATH.test(path)) return undefined
  const full = resolve(cwd, path)
  if (NETWORK_PATH.test(full)) return undefined
  // On Windows only a plain path on a drive: not \\?\, \\.\, \??\ or a share, however written.
  if (process.platform === "win32" && !/^[a-z]:\\(?![\\/])/i.test(full)) return undefined
  return full
}

/** The NT object namespace (\??\UNC\host\..., \??\GLOBALROOT\...), which Windows accepts too. */
const NT_PATH = /^[\\/]\?\?[\\/]/
