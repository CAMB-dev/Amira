import { deflateSync } from "node:zlib"
import { type Bitmap, decodeImage, type ImageFormat, imageSize, resizeBitmap } from "./decode.ts"
import { type CellSize, type Fit, fitImage } from "./fit.ts"
import { encodeSixel } from "./sixel.ts"

/**
 * How images reach the terminal: Sixel (Windows Terminal, xterm, foot, ...), the kitty graphics
 * protocol (kitty, Ghostty, WezTerm) or iTerm2's inline images (iTerm2, WezTerm, VS Code).
 */
export type ImageProtocol = "sixel" | "kitty" | "iterm2"

/** An image ready to print: its escape sequence and the cells it covers from the cursor. */
export interface ImageBlock {
  seq: string
  cols: number
  rows: number
}

/** The formats each protocol can show: kitty and Sixel get pixels decoded here. */
export function canShow(protocol: ImageProtocol, format: ImageFormat): boolean {
  return protocol === "iterm2" || format !== "webp"
}

export interface EncodeOptions {
  protocol: ImageProtocol
  maxCols: number
  maxRows: number
  cell: CellSize
}

/**
 * Sizes an image to fit and encodes it for the protocol. iTerm2's protocol takes the file as it
 * is, in a box of the cells it may cover; the others get it decoded, scaled and encoded here.
 * Throws for bytes that are not an image the protocol can show; undefined when it cannot fit.
 */
export function encodeImage(bytes: Uint8Array, opts: EncodeOptions): ImageBlock | undefined {
  const size = imageSize(bytes)
  if (!size) throw new Error("not a PNG, JPEG, GIF or WebP image")
  if (!canShow(opts.protocol, size.format)) throw new Error(`${size.format} images cannot be shown here`)
  const fit = fitImage(size, opts.maxCols, opts.maxRows, opts.cell)
  if (!fit) return undefined
  if (opts.protocol === "iterm2") return { seq: iterm2Image(bytes, fit), cols: fit.cols, rows: fit.rows }
  const bmp = resizeBitmap(decodeImage(bytes), fit.width, fit.height)
  const seq = opts.protocol === "sixel" ? encodeSixel(bmp) : kittyImage(bmp)
  return { seq, cols: fit.cols, rows: fit.rows }
}

/** iTerm2's OSC 1337 inline file, scaled by the terminal into the box of cells. */
export function iterm2Image(bytes: Uint8Array, fit: Fit): string {
  const b64 = Buffer.from(bytes).toString("base64")
  return `\x1b]1337;File=inline=1;size=${bytes.length};width=${fit.cols};height=${fit.rows};preserveAspectRatio=1:${b64}\x07`
}

/** kitty's graphics protocol: RGBA pixels, zlib-compressed, in chunks; the cursor does not move. */
export function kittyImage(bmp: Bitmap): string {
  const b64 = Buffer.from(deflateSync(bmp.data)).toString("base64")
  const CHUNK = 4096
  let out = ""
  for (let at = 0; at < b64.length || at === 0; at += CHUNK) {
    const more = at + CHUNK < b64.length ? 1 : 0
    const head = at === 0 ? `a=T,f=32,s=${bmp.width},v=${bmp.height},o=z,C=1,q=2,m=${more}` : `m=${more}`
    out += `\x1b_G${head};${b64.slice(at, at + CHUNK)}\x1b\\`
    if (!more) break
  }
  return out
}
