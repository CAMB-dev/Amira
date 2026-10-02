import type { ToolLine } from "./tool-renderers.ts"

/**
 * Experimental (D88): extensions that render parts of the model's Markdown replies themselves,
 * and extensions that draw images in the terminal. Amira keeps the terminal side: it finds out
 * whether and how the terminal draws images, reserves the rows an image takes, places, crops
 * and clears it, and shows `🖼️ alt` wherever an image cannot be drawn. What an image is made of
 * (reading files, downloading, decoding, encoding for a protocol) comes from an image provider;
 * without one, images are only their alt text.
 */

/** A part of a reply an extension may render instead of Amira. */
export type MarkdownNode =
  | {
      type: "code"
      /** The fence's language, as written (e.g. "mermaid"); matched case-insensitively. */
      lang: string
      /** The whole info string after the fence. */
      info: string
      /** The block's text, without the fences, lines joined with "\n". */
      code: string
    }
  | {
      /** An image standing on a line of its own (maybe inside a link). */
      type: "image"
      url: string
      alt: string
    }

/** Which nodes a renderer is asked for: standalone images, or code blocks in these languages. */
export type MarkdownRenderMatch = { image: true } | { codeLang: string[] }

export interface MarkdownRenderContext {
  /** Columns the lines may take; longer lines are cut. */
  width: number
  /**
   * Whether an image result would be drawn here: an image provider is installed and this
   * terminal draws images. When false, an image result shows as Amira's own rendering.
   */
  images: boolean
  /** The most rows an image may take now; images are scaled down to `width` × this. */
  maxImageRows: number
}

/**
 * What a node renders as: lines of text (styled by the frontend after their kind, like a
 * view's lines), or an image, which goes to the image providers and is drawn like a Markdown
 * image. Undefined declines: the next renderer is asked, and in the end Amira renders it.
 */
export type MarkdownRenderResult = { lines: ToolLine[] } | { image: ImageInput }

export interface MarkdownRendererDefinition {
  /** Names the renderer in errors; one extension's ids must differ. */
  id: string
  match: MarkdownRenderMatch
  /**
   * Renderers are asked highest priority first (equal ones in the order they were registered);
   * the first that returns a result wins. One that throws or rejects is reported
   * (extension.error, once per renderer) and the next one is asked. Default 0.
   */
  priority?: number
  /**
   * How long the inline transcript holds what follows the node while an async result is on its
   * way; then Amira's own rendering is committed instead. Default 3000 ms, at most 15000.
   * The full-screen transcript shows Amira's rendering until the result arrives, whenever.
   */
  waitMs?: number
  /**
   * Renders a node, once it is complete (a code block once it closes). Results are kept by the
   * node's text and the context, so it is asked again only for another width, another answer
   * of `images` or `maxImageRows`, after the renderers changed, or once a result was let go of
   * (keep expensive work cached yourself, by the source). May be async; Amira's own rendering
   * shows meanwhile. Lines past 2000 are cut.
   */
  render(
    node: MarkdownNode,
    ctx: MarkdownRenderContext,
  ): MarkdownRenderResult | undefined | Promise<MarkdownRenderResult | undefined>
}

/** How images reach the terminal: Sixel, the kitty graphics protocol, or iTerm2's inline images. */
export type ImageProtocol = "sixel" | "kitty" | "iterm2"

/**
 * An image to show: a URL or path as a reply wrote it (http(s), file:, absolute, or relative to
 * the working directory; the provider decides what it reads), or the file's bytes.
 */
export type ImageInput = { url: string } | { data: Uint8Array; mimeType?: string }

/** The size an image is drawn at: pixels, and the cells that covers (Amira decides both). */
export interface ImageFit {
  width: number
  height: number
  cols: number
  rows: number
}

export interface ImageOpenContext {
  protocol: ImageProtocol
  /** Where relative paths are found: the session's working directory now. */
  cwd: string
  /** Aborts when the image is no longer wanted or took too long. */
  signal: AbortSignal
}

/** What Amira needs of an image at one fitted size. */
export interface ImageEncodeRequest {
  protocol: ImageProtocol
  fit: ImageFit
  /** A cell's height in pixels: where each row of cells starts in the image. */
  cellHeight: number
  /**
   * Drawn whole only (the inline transcript): Sixel needs only the bands from pixel row 0. When
   * false (the full-screen transcript draws any run of its rows), every phase a row starts in.
   */
  whole: boolean
  /**
   * Asked when the work would start, e.g. after waiting for its turn: false means nobody wants it
   * any more, and the encode resolves null without doing it.
   */
  wanted?: () => boolean
}

/**
 * An image encoded for a protocol, at the fitted size's pixels. Amira frames it (the Sixel
 * header, kitty's chunks and placements, iTerm2's OSC 1337) and slices it.
 * - sixel: `palette` holds the color registers (`#i;2;r;g;b`...), and `phases[p]` the bands of
 *   six pixel rows starting at pixel row p (0 ≤ p < 6), without the `-` between them, for every
 *   phase a row of cells starts in (`(row * cellHeight) % 6`; only 0 when `whole`).
 * - kitty: `data` is the RGBA pixels (f=32), zlib-compressed (o=z), in base64.
 * - iterm2: `data` is the image file in base64, `size` its length in bytes.
 */
export type ImagePayload =
  | { protocol: "sixel"; width: number; height: number; palette: string; phases: Record<number, string[]> }
  | { protocol: "kitty"; width: number; height: number; data: string }
  | { protocol: "iterm2"; data: string; size: number }

/** An image a provider opened: its size in pixels, known before anything is drawn. */
export interface OpenedImage {
  width: number
  height: number
  /**
   * Encodes it at a fitted size. Called again for other sizes (a resize) and after Amira let go
   * of an earlier result; keep what is worth keeping. Rejects when it cannot.
   */
  encode(req: ImageEncodeRequest): Promise<ImagePayload | null>
}

export interface ImageProvider {
  id: string
  /** Providers are asked highest priority first; the first that opens the image draws it. Default 0. */
  priority?: number
  /**
   * Opens an image: finds and reads it, checks it is one this provider can show with
   * `ctx.protocol`, and reads its size. Undefined (or a rejection) when it cannot: the next
   * provider is asked, and in the end the alt text shows.
   */
  open(input: ImageInput, ctx: ImageOpenContext): Promise<OpenedImage | undefined>
}
