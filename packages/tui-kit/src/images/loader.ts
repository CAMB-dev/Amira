import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ImageSupport } from "../capabilities.ts"
import { type ImageFormat, imageSize } from "./decode.ts"
import { canShow, encodeImage, type ImageBlock } from "./encode.ts"
import { fitImage } from "./fit.ts"
import { type Prepared, type PrepareRequest, prepareOffThread } from "./prepare.ts"
import { ScreenImage } from "./screen.ts"

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
  /** Images loaded at once; the others wait their turn. Default 2. */
  concurrency?: number
  /** Bytes of image files kept for drawing them at other sizes (full screen). Default 64 MB. */
  keepBytes?: number
  /** How images for the full screen are decoded and encoded; default in a worker. */
  prepare?: (req: PrepareRequest) => Promise<Prepared>
}

const MB = 1024 * 1024
/** Results kept at most, failures included (they weigh nothing in characters). */
const MAX_ENTRIES = 500

/** Content types that are images this can show (the signature is checked as well). */
const IMAGE_TYPES = /^image\/(png|jpeg|jpg|gif|webp)\b/i
const REMOTE = /^https?:\/\//i

/** A load that waited its turn longer than the loader's timeout: not cached, so it can be tried again. */
class Skipped extends Error {}

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
  /** Loads running (or handed their turn), and those waiting for one. */
  private active = 0
  private queue: (() => void)[] = []
  /** Images of the full-screen view by source, oldest first, and the bytes their files hold. */
  private screens = new Map<string, ScreenSource>()
  private keptBytes = 0

  constructor(private opts: ImageLoaderOptions) {
    this.maxBytes = opts.maxBytes ?? 10 * MB
    this.timeoutMs = opts.timeoutMs ?? 10_000
  }

  /** The most rows an image may take now. */
  maxRows(): number {
    return this.opts.maxRows()
  }

  /** The image at `src`, fitted to `maxCols` columns; undefined when it cannot be shown. */
  load(src: string, maxCols: number): Promise<ImageBlock | undefined> {
    const maxRows = this.opts.maxRows()
    const remote = REMOTE.test(src)
    const source = this.source(src)
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
    hit = this.limited(() => this.encode(source, remote, maxCols, maxRows)).then(
      (block) => {
        this.remember(key, block?.seq.length ?? 0)
        return block
      },
      (err) => {
        if (err instanceof Skipped) this.cache.delete(key)
        else this.remember(key, 0)
        return undefined
      },
    )
    this.cache.set(key, hit)
    return hit
  }

  /** Where an image is: its URL, or the local file (relative to the working directory now). */
  private source(src: string): string | undefined {
    if (REMOTE.test(src)) return src
    const cwd = this.opts.cwd
    return localPath(src, typeof cwd === "string" ? cwd : cwd())
  }

  /**
   * The image at `src` as the full-screen view draws it: loading, then (once its bytes are in)
   * fitted to any size synchronously, so its rows are known when a block is laid out; each size
   * gets ready off the main thread. Undefined for a source that is never read (a network path).
   */
  screen(src: string): ScreenSource | undefined {
    const source = this.source(src)
    if (source === undefined) return undefined
    const hit = this.screens.get(source)
    if (hit) {
      this.screens.delete(source)
      this.screens.set(source, hit)
      return hit
    }
    const s = new ScreenSource(this.opts.support, (req) =>
      this.limited(() => (this.opts.prepare ?? prepareOffThread)(req), false),
    )
    this.screens.set(source, s)
    this.limited(async () => {
      const bytes = await this.bytes(source, REMOTE.test(source))
      const size = imageSize(bytes)
      if (!size || !canShow(this.opts.support.protocol, size.format)) throw new Error("cannot show")
      return { bytes, size }
    }, false).then(
      ({ bytes, size }) => {
        s.settle(bytes, size)
        this.keptBytes += bytes.length
        this.trimScreens()
      },
      () => s.settle(undefined),
    )
    this.trimScreens()
    return s
  }

  /** Lets go of the oldest sources past the limits; their images drawn so far stay usable. */
  private trimScreens() {
    const limit = this.opts.keepBytes ?? 64 * MB
    for (const [k, s] of this.screens) {
      if (this.keptBytes <= limit && this.screens.size <= MAX_ENTRIES) break
      this.screens.delete(k)
      this.keptBytes -= s.byteLength
    }
  }

  /**
   * Runs `task` once fewer than `concurrency` loads run: decoding blocks the thread, and a reply
   * with dozens of images would otherwise start them all at once. One that waited longer than
   * the timeout is skipped (when `skip`), its fallback committed long before.
   */
  private async limited<T>(task: () => Promise<T>, skip = true): Promise<T> {
    if (this.active >= (this.opts.concurrency ?? 2)) {
      const queued = performance.now()
      // The turn is handed over by the load that ends: `active` already counts this one.
      await new Promise<void>((go) => this.queue.push(go))
      if (skip && performance.now() - queued > this.timeoutMs) {
        this.release()
        throw new Skipped()
      }
    } else this.active++
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private release(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.active--
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

/** Sizes of one image kept (the screen was resized, a block drawn narrower while selected). */
const SIZES_KEPT = 4

/** An image file for the full-screen view: loading, failed, or in and drawable at any size. */
export class ScreenSource {
  state: "loading" | "ready" | "failed" = "loading"
  size: { width: number; height: number; format: ImageFormat } | undefined
  private bytes: Uint8Array | undefined
  private sizes = new Map<string, ScreenImage>()
  private listeners = new Set<() => void>()

  constructor(
    private support: ImageSupport,
    private prepare: (req: PrepareRequest) => Promise<Prepared>,
  ) {}

  get byteLength(): number {
    return this.bytes?.length ?? 0
  }

  settle(bytes: Uint8Array | undefined, size?: ScreenSource["size"]): void {
    if (bytes && size) {
      this.bytes = bytes
      this.size = size
      this.state = "ready"
    } else this.state = "failed"
    for (const fn of this.listeners) fn()
    this.listeners.clear()
  }

  /** Calls `fn` once when it is in or failed; never when it is already. */
  onSettled(fn: () => void): void {
    if (this.state === "loading") this.listeners.add(fn)
  }

  /**
   * The image fitted to `maxCols` × `maxRows` cells, which starts getting ready if it is new;
   * undefined while loading, when it failed, or when nothing fits.
   */
  image(maxCols: number, maxRows: number): ScreenImage | undefined {
    const { size, bytes } = this
    if (!size || !bytes) return undefined
    const { protocol, cell } = this.support
    const fit = fitImage(size, maxCols, maxRows, cell)
    if (!fit) return undefined
    const key = `${fit.width}x${fit.height}`
    const hit = this.sizes.get(key)
    if (hit) {
      this.sizes.delete(key)
      this.sizes.set(key, hit)
      return hit
    }
    const image = new ScreenImage(protocol, fit, cell.height, protocol === "iterm2" ? bytes : undefined)
    if (protocol !== "iterm2")
      this.prepare({ bytes, protocol, fit, cellHeight: cell.height }).then(
        (p) => image.settle(p),
        () => image.settle(undefined),
      )
    this.sizes.set(key, image)
    if (this.sizes.size > SIZES_KEPT) this.sizes.delete(this.sizes.keys().next().value!)
    return image
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
