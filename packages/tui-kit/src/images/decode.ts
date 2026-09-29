import { convertIndexedToRgb, decode as decodePng } from "fast-png"
import { decode as decodeJpeg } from "jpeg-js"
import { GifReader } from "omggif"

export type ImageFormat = "png" | "jpeg" | "gif" | "webp"

/** Pixels, four bytes (RGBA) each, row by row. */
export interface Bitmap {
  width: number
  height: number
  data: Uint8Array
}

/** Images with more pixels than this are not decoded (a 4000×3000 photo has 12 M). */
export const MAX_PIXELS = 40_000_000

/** What the bytes are, by their signature; undefined for anything else (SVG, BMP, ...). */
export function sniffFormat(b: Uint8Array): ImageFormat | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png"
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg"
  if (b.length >= 6 && ascii(b, 0, 4) === "GIF8") return "gif"
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp"
  return undefined
}

function ascii(b: Uint8Array, at: number, n: number): string {
  return String.fromCharCode(...b.subarray(at, at + n))
}

const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8)
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!

/**
 * The size in pixels an image declares in its header, without decoding it; undefined when the
 * header is not one of the known formats or is cut short.
 */
export function imageSize(b: Uint8Array): { format: ImageFormat; width: number; height: number } | undefined {
  const format = sniffFormat(b)
  const out = (width: number, height: number) =>
    width > 0 && height > 0 && format ? { format, width, height } : undefined
  switch (format) {
    case "png":
      return b.length >= 24 && ascii(b, 12, 4) === "IHDR" ? out(u32be(b, 16), u32be(b, 20)) : undefined
    case "gif":
      return b.length >= 10 ? out(u16le(b, 6), u16le(b, 8)) : undefined
    case "jpeg": {
      // The first start-of-frame segment has the size.
      let at = 2
      while (at + 9 < b.length) {
        if (b[at] !== 0xff) return undefined
        const marker = b[at + 1]!
        if (marker === 0xff) {
          at++
          continue
        }
        const len = u16be(b, at + 2)
        const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        if (sof) return out(u16be(b, at + 7), u16be(b, at + 5))
        at += 2 + len
      }
      return undefined
    }
    case "webp": {
      const chunk = ascii(b, 12, 4)
      if (chunk === "VP8 " && b.length >= 30) return out(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff)
      if (chunk === "VP8L" && b.length >= 25) {
        const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
        return out((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
      }
      if (chunk === "VP8X" && b.length >= 30) return out(u24le(b, 24) + 1, u24le(b, 27) + 1)
      return undefined
    }
    default:
      return undefined
  }
}

/**
 * Decodes a PNG, JPEG or GIF (its first frame) to RGBA; WebP and anything else throw. Pure
 * JavaScript: fast-png, jpeg-js and omggif.
 */
export function decodeImage(bytes: Uint8Array): Bitmap {
  const size = imageSize(bytes)
  if (!size) throw new Error("not a PNG, JPEG, GIF or WebP image")
  if (size.width * size.height > MAX_PIXELS)
    throw new Error(`image too large to show (${size.width}×${size.height})`)
  switch (size.format) {
    case "png":
      return pngToRgba(bytes)
    case "jpeg": {
      const img = decodeJpeg(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: MAX_PIXELS / 1e6,
        maxMemoryUsageInMB: 1024,
      })
      return { width: img.width, height: img.height, data: img.data }
    }
    case "gif": {
      const gif = new GifReader(bytes)
      const data = new Uint8Array(gif.width * gif.height * 4)
      gif.decodeAndBlitFrameRGBA(0, data)
      return { width: gif.width, height: gif.height, data }
    }
    default:
      throw new Error(`${size.format} images cannot be decoded here`)
  }
}

function pngToRgba(bytes: Uint8Array): Bitmap {
  const png = decodePng(bytes)
  const { width, height } = png
  const n = width * height
  const out = new Uint8Array(n * 4)
  if (png.palette) {
    const rgb = convertIndexedToRgb(png)
    const ch = rgb.length / n
    for (let i = 0; i < n; i++) {
      out[i * 4] = rgb[i * ch]!
      out[i * 4 + 1] = rgb[i * ch + 1]!
      out[i * 4 + 2] = rgb[i * ch + 2]!
      out[i * 4 + 3] = ch === 4 ? rgb[i * ch + 3]! : 255
    }
    return { width, height, data: out }
  }
  const ch = png.channels
  const depth = png.depth
  const src = png.data
  const max = 2 ** depth - 1
  /** Sample `c` of pixel `x` in row `y`, scaled to 0-255. */
  let sample: (y: number, x: number, c: number) => number
  if (depth >= 8) {
    const shift = depth === 16 ? 8 : 0
    sample = (y, x, c) => src[(y * width + x) * ch + c]! >> shift
  } else {
    // Samples below 8 bits are packed, each row starting on a byte.
    const rowBytes = Math.ceil((width * ch * depth) / 8)
    sample = (y, x, c) => {
      const bit = (x * ch + c) * depth
      const byte = src[y * rowBytes + (bit >> 3)]!
      return Math.round((((byte >> (8 - depth - (bit & 7))) & max) * 255) / max)
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (ch >= 3) {
        out[o] = sample(y, x, 0)
        out[o + 1] = sample(y, x, 1)
        out[o + 2] = sample(y, x, 2)
      } else {
        const v = sample(y, x, 0)
        out[o] = v
        out[o + 1] = v
        out[o + 2] = v
      }
      out[o + 3] = ch === 4 ? sample(y, x, 3) : ch === 2 ? sample(y, x, 1) : 255
    }
  }
  return { width, height, data: out }
}

/**
 * Scales a bitmap to `width`×`height` by averaging the source pixels each target pixel covers
 * (weighted by their alpha, so transparent pixels do not darken the edges). Meant for shrinking;
 * growing repeats pixels.
 */
export function resizeBitmap(src: Bitmap, width: number, height: number): Bitmap {
  if (width === src.width && height === src.height) return src
  const out = new Uint8Array(width * height * 4)
  const sx = src.width / width
  const sy = src.height / height
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy)
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * src.width + x0) * 4
        for (let xx = x0; xx < x1; xx++, i += 4) {
          const alpha = src.data[i + 3]!
          r += src.data[i]! * alpha
          g += src.data[i + 1]! * alpha
          b += src.data[i + 2]! * alpha
          a += alpha
          count++
        }
      }
      const o = (y * width + x) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round(a / count)
    }
  }
  return { width, height, data: out }
}
