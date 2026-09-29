/**
 * What the renderers need to draw images, and what they get from whoever makes them (an image
 * provider, D88). The kit is protocol-aware only for placing images: it fits them into cells,
 * frames and slices the encoded data, places, crops and clears them. Reading, decoding and
 * encoding images is not done here.
 */

/**
 * How images reach the terminal: Sixel (Windows Terminal, xterm, foot, ...), the kitty graphics
 * protocol (kitty, Ghostty, WezTerm) or iTerm2's inline images (iTerm2, WezTerm, VS Code).
 */
export type ImageProtocol = "sixel" | "kitty" | "iterm2"

/** The size of a terminal cell in pixels. */
export interface CellSize {
  width: number
  height: number
}

/** How an image is drawn: its size in pixels, and the cells that takes. */
export interface Fit {
  width: number
  height: number
  cols: number
  rows: number
}

/** An image ready to print: its escape sequence and the cells it covers from the cursor. */
export interface ImageBlock {
  seq: string
  cols: number
  rows: number
}

/**
 * An image encoded for a protocol at a fitted size's pixels, which the kit frames and slices.
 * sixel: the color registers, and for each phase p (a row of cells starting at pixel row y has
 * phase y % 6) the bands of six pixel rows from row p, without the `-` between them. kitty: the
 * RGBA pixels, zlib-compressed, in base64. iterm2: the file in base64, and its length in bytes.
 */
export type ImagePayload =
  | { protocol: "sixel"; width: number; height: number; palette: string; phases: Record<number, string[]> }
  | { protocol: "kitty"; width: number; height: number; data: string }
  | { protocol: "iterm2"; data: string; size: number }

export interface EncodeRequest {
  protocol: ImageProtocol
  fit: Fit
  /** Cell height in pixels: where each row of cells starts in the image. */
  cellHeight: number
  /** Drawn whole only: Sixel needs the bands of phase 0 alone. */
  whole: boolean
  /** Asked when the work would start: false skips it (null). */
  wanted?: () => boolean
}

/** An image opened for drawing: its size in pixels, and how to encode it at a fitted size. */
export interface OpenedImage {
  width: number
  height: number
  encode(req: EncodeRequest): Promise<ImagePayload | null>
}

/** An image to show: a URL or path as written, or the file's bytes. */
export type ImageInput = { url: string } | { data: Uint8Array; mimeType?: string }

/** Opens images (the image providers); undefined when none can. */
export type ImageOpener = (
  input: ImageInput,
  ctx: { protocol: ImageProtocol; cwd: string; signal: AbortSignal },
) => Promise<OpenedImage | undefined>
