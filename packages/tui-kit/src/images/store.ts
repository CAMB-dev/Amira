import type { ImageSupport } from "../capabilities.ts"
import { fitImage } from "./fit.ts"
import { type PrepareImage, ScreenImage } from "./screen.ts"
import { inlineImage, validPayload } from "./sequence.ts"
import type { ImageBlock, ImageInput, ImageOpener, OpenedImage } from "./types.ts"

export interface ImageStoreOptions {
  support: ImageSupport
  /** Opens images: the image providers (D88). */
  open: ImageOpener
  /** Relative paths are found from here (by the providers): the directory, or where to ask for it. */
  cwd: string | (() => string)
  /** The most rows an image may take, asked each time (the terminal's height changes). */
  maxRows: () => number
  /** How long opening and encoding an image for the inline transcript may take. Default 10 s. */
  timeoutMs?: number
}

/** Opened images remembered (failures too), by source; the providers decide what they keep of each. */
const OPENED_KEPT = 500
/** Images encoded for the inline transcript, kept while it may still ask for them again. */
const INLINE_KEPT = 16
const INLINE_CHARS = 32 * 1024 * 1024

/**
 * The images replies show, for one session, as the renderers need them: opened by the image
 * providers (which read, download, decode and encode them), fitted to the cells here, framed
 * for the protocol. `load` gives the inline transcript an image to print whole; `screen` the
 * full-screen transcript an image it draws at any size and slice.
 */
export class ImageStore {
  readonly timeoutMs: number
  private opened = new Map<string, Promise<OpenedImage | undefined>>()
  private inlines = new Map<string, { block: Promise<ImageBlock | undefined>; chars: number }>()
  private inlineChars = 0
  private screens = new Map<string, ScreenSource>()
  private dataIds = new WeakMap<Uint8Array, number>()
  private nextData = 1

  constructor(private opts: ImageStoreOptions) {
    this.timeoutMs = opts.timeoutMs ?? 10_000
  }

  get support(): ImageSupport {
    return this.opts.support
  }

  /** The most rows an image may take now. */
  maxRows(): number {
    return this.opts.maxRows()
  }

  /** The image at `url`, fitted to `maxCols` columns, to print whole; undefined when it cannot be shown. */
  load(url: string, maxCols: number): Promise<ImageBlock | undefined> {
    return this.inline({ url }, maxCols)
  }

  /** The image, fitted to `maxCols` columns and the rows it may take, to print whole. */
  inline(input: ImageInput, maxCols: number): Promise<ImageBlock | undefined> {
    const maxRows = this.opts.maxRows()
    const source = this.key(input)
    const key = `${maxCols}x${maxRows} ${source}`
    const hit = this.inlines.get(key)
    if (hit) {
      this.inlines.delete(key)
      this.inlines.set(key, hit)
      return hit.block
    }
    const { protocol, cell } = this.opts.support
    const block = (async () => {
      const image = await this.open(input, source)
      const fit = image && fitImage(image, maxCols, maxRows, cell)
      if (!fit) return undefined
      // Encoding is slow: let the frame that shows the fallback be drawn first.
      await new Promise((r) => setTimeout(r, 0))
      const payload = await withTimeout(
        image.encode({ protocol, fit, cellHeight: cell.height, whole: true }),
        this.timeoutMs,
      )
      return payload && validPayload(payload, protocol) ? inlineImage(payload, fit) : undefined
    })().catch(() => undefined)
    const entry = { block, chars: 0 }
    this.inlines.set(key, entry)
    block.then((b) => {
      if (this.inlines.get(key) !== entry) return
      entry.chars = b?.seq.length ?? 0
      this.inlineChars += entry.chars
      this.trimInline()
    })
    this.trimInline()
    return block
  }

  private trimInline() {
    for (const [k, e] of this.inlines) {
      if (this.inlines.size <= INLINE_KEPT && this.inlineChars <= INLINE_CHARS) break
      this.inlines.delete(k)
      this.inlineChars -= e.chars
    }
  }

  /**
   * The image as the full-screen view draws it: loading, then (once opened) fitted to any size
   * synchronously, so its rows are known when a block is laid out; each size is encoded when
   * it is wanted.
   */
  screen(input: ImageInput): ScreenSource {
    const source = this.key(input)
    const hit = this.screens.get(source)
    if (hit) {
      this.screens.delete(source)
      this.screens.set(source, hit)
      return hit
    }
    const s = new ScreenSource(this.opts.support)
    this.screens.set(source, s)
    this.open(input, source).then(
      (image) => s.settle(image),
      () => s.settle(undefined),
    )
    for (const k of this.screens.keys()) {
      if (this.screens.size <= OPENED_KEPT) break
      this.screens.delete(k)
    }
    return s
  }

  /** The image opened, once per source: a failure is remembered too, unless it only ran out of time. */
  private open(input: ImageInput, source: string): Promise<OpenedImage | undefined> {
    const hit = this.opened.get(source)
    if (hit) {
      this.opened.delete(source)
      this.opened.set(source, hit)
      return hit
    }
    const signal = AbortSignal.timeout(this.timeoutMs)
    const opened = this.opts
      .open(input, { protocol: this.opts.support.protocol, cwd: this.cwd(), signal })
      .catch(() => undefined)
      .then((image) => {
        if (!image && signal.aborted && this.opened.get(source) === opened) this.opened.delete(source)
        return image
      })
    this.opened.set(source, opened)
    for (const k of this.opened.keys()) {
      if (this.opened.size <= OPENED_KEPT) break
      this.opened.delete(k)
    }
    return opened
  }

  private cwd(): string {
    const cwd = this.opts.cwd
    return typeof cwd === "string" ? cwd : cwd()
  }

  /** What tells images apart: a URL (a relative one with the directory it is found from), or the bytes. */
  private key(input: ImageInput): string {
    if ("url" in input)
      return /^[a-z][a-z0-9+.-]*:\/\//i.test(input.url) ? input.url : `${this.cwd()}\0${input.url}`
    let id = this.dataIds.get(input.data)
    if (id === undefined) {
      id = this.nextData++
      this.dataIds.set(input.data, id)
    }
    return `\0data:${id}`
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    ;(timer as { unref?: () => void }).unref?.()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** Sizes of one image kept (the screen was resized, a block drawn narrower while selected). */
const SIZES_KEPT = 4

/** An image for the full-screen view: opening, failed, or opened and drawable at any size. */
export class ScreenSource {
  state: "loading" | "ready" | "failed" = "loading"
  size: { width: number; height: number } | undefined
  private opened: OpenedImage | undefined
  private sizes = new Map<string, ScreenImage>()
  private listeners = new Set<() => void>()

  constructor(private support: ImageSupport) {}

  settle(image: OpenedImage | undefined): void {
    if (image) {
      this.opened = image
      this.size = { width: image.width, height: image.height }
      this.state = "ready"
    } else this.state = "failed"
    const fns = [...this.listeners]
    this.listeners.clear()
    for (const fn of fns) fn()
  }

  /** Calls `fn` once when it is opened or failed; never when it is already. */
  onSettled(fn: () => void): void {
    if (this.state === "loading") this.listeners.add(fn)
  }

  /**
   * The image fitted to `maxCols` × `maxRows` cells (encoded once it is wanted); undefined while
   * loading, when it failed, or when nothing fits.
   */
  image(maxCols: number, maxRows: number): ScreenImage | undefined {
    const { size } = this
    const opened = this.opened
    if (!size || !opened) return undefined
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
    const prepare: PrepareImage = async (wanted) =>
      opened.encode({ protocol, fit, cellHeight: cell.height, whole: false, wanted })
    const image = new ScreenImage(protocol, fit, cell.height, prepare)
    this.sizes.set(key, image)
    if (this.sizes.size > SIZES_KEPT) this.sizes.delete(this.sizes.keys().next().value!)
    return image
  }
}
