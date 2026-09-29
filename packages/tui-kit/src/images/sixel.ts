import type { Bitmap } from "./decode.ts"

export interface SixelOptions {
  /** Palette size; 256 is what Windows Terminal and xterm.js offer. */
  maxColors?: number
}

/** Pixels with less alpha than this are left out (the terminal's background shows). */
const OPAQUE = 128

/**
 * Encodes a bitmap as a Sixel image (DCS … ST) at its size in pixels, 1:1 aspect, with
 * transparent pixels left undrawn. Up to `maxColors` colors are used exactly; more are reduced
 * by median cut and Floyd–Steinberg dithering. The cursor is left where the image ends; the
 * caller decides where it goes next.
 */
export function encodeSixel(bmp: Bitmap, opts: SixelOptions = {}): string {
  const maxColors = Math.max(2, Math.min(256, opts.maxColors ?? 256))
  const { width, height } = bmp
  const { palette, index } = quantize(bmp, maxColors)
  return `${sixelHead(width, height)}${sixelPalette(palette)}${sixelBands(index, width, height).join("-")}\x1b\\`
}

/** The start of a Sixel image of `width`×`height` pixels: 1:1 aspect, transparent background. */
export function sixelHead(width: number, height: number): string {
  return `\x1bP0;1;0q"1;1;${width};${height}`
}

/** The color registers of a palette of 0xRRGGBB colors, in percent as Sixel has them. */
export function sixelPalette(palette: number[]): string {
  const pct = (v: number) => Math.round((v * 100) / 255)
  let out = ""
  palette.forEach((c, i) => {
    out += `#${i};2;${pct(c >> 16)};${pct((c >> 8) & 255)};${pct(c & 255)}`
  })
  return out
}

/**
 * The bands of six pixel rows of an image `quantize` indexed, starting at pixel row `start`
 * (the rows above it left out), without the `-` between them. A slice of the image is the
 * bands it covers joined by `-`, after the same palette.
 */
export function sixelBands(index: Int16Array, width: number, height: number, start = 0): string[] {
  const bands: string[] = []
  let colors = 0
  for (let i = 0; i < index.length; i++) if (index[i]! >= colors) colors = index[i]! + 1
  // One row of sixels per color, reused from band to band; only the colors a band uses are cleared.
  const bits = new Uint8Array(Math.max(1, colors) * width)
  const used = new Uint8Array(Math.max(1, colors))
  const list: number[] = []
  for (let y0 = start; y0 < height; y0 += 6) {
    for (let dy = 0; dy < 6 && y0 + dy < height; dy++) {
      const base = (y0 + dy) * width
      for (let x = 0; x < width; x++) {
        const c = index[base + x]!
        if (c < 0) continue
        if (!used[c]) {
          used[c] = 1
          list.push(c)
        }
        bits[c * width + x]! |= 1 << dy
      }
    }
    list.sort((a, b) => a - b)
    const parts: string[] = []
    for (const c of list) {
      const row = bits.subarray(c * width, (c + 1) * width)
      parts.push(`#${c}${sixelRow(row)}`)
      row.fill(0)
      used[c] = 0
    }
    list.length = 0
    bands.push(parts.join("$"))
  }
  return bands
}

/** One color's row of sixels, run-length encoded, without its trailing empty sixels. */
function sixelRow(bits: Uint8Array): string {
  let end = bits.length
  while (end > 0 && bits[end - 1] === 0) end--
  let out = ""
  let x = 0
  while (x < end) {
    const v = bits[x]!
    let n = 1
    while (x + n < end && bits[x + n] === v) n++
    const ch = String.fromCharCode(63 + v)
    out += n > 3 ? `!${n}${ch}` : ch.repeat(n)
    x += n
  }
  return out
}

/**
 * A palette of 0xRRGGBB colors and each pixel's entry in it (-1: transparent). The colors are
 * kept exactly when there are few enough, in the order they first appear.
 */
export function quantize(bmp: Bitmap, maxColors: number): { palette: number[]; index: Int16Array } {
  const { data } = bmp
  const n = bmp.width * bmp.height
  const index = new Int16Array(n).fill(-1)
  const exact = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3]! < OPAQUE) continue
    const c = (data[i * 4]! << 16) | (data[i * 4 + 1]! << 8) | data[i * 4 + 2]!
    let at = exact.get(c)
    if (at === undefined) {
      if (exact.size >= maxColors) return dithered(bmp, maxColors)
      at = exact.size
      exact.set(c, at)
    }
    index[i] = at
  }
  return { palette: [...exact.keys()], index }
}

/** 5 bits per channel: the histogram and lookup key. */
const key15 = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)

interface Box {
  keys: number[]
  count: number
}

/** Median cut over a 15-bit histogram, then Floyd–Steinberg dithering to the palette. */
function dithered(bmp: Bitmap, maxColors: number): { palette: number[]; index: Int16Array } {
  const { data, width, height } = bmp
  const n = width * height
  const hist = new Uint32Array(32768)
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3]! < OPAQUE) continue
    hist[key15(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!)]!++
  }
  const keys: number[] = []
  let total = 0
  for (let k = 0; k < 32768; k++) {
    if (hist[k]) {
      keys.push(k)
      total += hist[k]!
    }
  }
  const channel = (k: number, ch: number) => (k >> (10 - ch * 5)) & 31
  const boxes: Box[] = [{ keys, count: total }]
  while (boxes.length < maxColors) {
    // Split the box with the most pixels (that can be split) along its widest channel, at the median.
    let best = -1
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i]!.keys.length > 1 && (best === -1 || boxes[i]!.count > boxes[best]!.count)) best = i
    }
    if (best === -1) break
    const box = boxes[best]!
    let ch = 0
    let span = -1
    for (let c = 0; c < 3; c++) {
      let lo = 31
      let hi = 0
      for (const k of box.keys) {
        const v = channel(k, c)
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      if (hi - lo > span) {
        span = hi - lo
        ch = c
      }
    }
    box.keys.sort((a, b) => channel(a, ch) - channel(b, ch) || a - b)
    let acc = 0
    let cut = 1
    for (; cut < box.keys.length; cut++) {
      acc += hist[box.keys[cut - 1]!]!
      if (acc * 2 >= box.count) break
    }
    cut = Math.min(cut, box.keys.length - 1)
    const low = box.keys.slice(0, cut)
    const high = box.keys.slice(cut)
    const sum = (ks: number[]) => ks.reduce((s, k) => s + hist[k]!, 0)
    boxes.splice(best, 1, { keys: low, count: sum(low) }, { keys: high, count: sum(high) })
  }
  const palette = boxes.map((box) => {
    let r = 0
    let g = 0
    let b = 0
    for (const k of box.keys) {
      const w = hist[k]!
      r += (channel(k, 0) * 8 + 4) * w
      g += (channel(k, 1) * 8 + 4) * w
      b += (channel(k, 2) * 8 + 4) * w
    }
    const c = Math.max(1, box.count)
    return (Math.round(r / c) << 16) | (Math.round(g / c) << 8) | Math.round(b / c)
  })
  const nearestCache = new Int16Array(32768).fill(-1)
  const nearest = (r: number, g: number, b: number) => {
    const k = key15(r, g, b)
    const hit = nearestCache[k]!
    if (hit >= 0) return hit
    let best = 0
    let bestD = Number.POSITIVE_INFINITY
    for (let i = 0; i < palette.length; i++) {
      const c = palette[i]!
      const dr = (c >> 16) - r
      const dg = ((c >> 8) & 255) - g
      const db = (c & 255) - b
      const d = dr * dr * 3 + dg * dg * 4 + db * db * 2
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    nearestCache[k] = best
    return best
  }
  const index = new Int16Array(n).fill(-1)
  // Errors carried to this row and the next, per channel.
  let cur = new Float32Array((width + 2) * 3)
  let next = new Float32Array((width + 2) * 3)
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
  for (let y = 0; y < height; y++) {
    next.fill(0)
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (data[i * 4 + 3]! < OPAQUE) continue
      const e = (x + 1) * 3
      const r = clamp(data[i * 4]! + cur[e]!)
      const g = clamp(data[i * 4 + 1]! + cur[e + 1]!)
      const b = clamp(data[i * 4 + 2]! + cur[e + 2]!)
      const p = nearest(r, g, b)
      index[i] = p
      const c = palette[p]!
      const err = [r - (c >> 16), g - ((c >> 8) & 255), b - (c & 255)]
      for (let ch = 0; ch < 3; ch++) {
        const v = err[ch]!
        cur[e + 3 + ch]! += (v * 7) / 16
        next[e - 3 + ch]! += (v * 3) / 16
        next[e + ch]! += (v * 5) / 16
        next[e + 3 + ch]! += v / 16
      }
    }
    ;[cur, next] = [next, cur]
  }
  return { palette, index }
}
