import type { Fit, ImageBlock, ImagePayload } from "./types.ts"

/** The start of a Sixel image of `width`×`height` pixels: 1:1 aspect, transparent background. */
export function sixelHead(width: number, height: number): string {
  return `\x1bP0;1;0q"1;1;${width};${height}`
}

const KITTY_CHUNK = 4096

/** A kitty graphics command carrying `data` (base64) in chunks, `keys` on the first. */
export function kittyChunks(keys: string, data: string): string {
  let out = ""
  for (let at = 0; at < data.length || at === 0; at += KITTY_CHUNK) {
    const more = at + KITTY_CHUNK < data.length ? 1 : 0
    out += `\x1b_G${at === 0 ? `${keys},` : ""}m=${more};${data.slice(at, at + KITTY_CHUNK)}\x1b\\`
    if (!more) break
  }
  return out
}

/** iTerm2's OSC 1337 inline file, scaled by the terminal into the box of cells. */
export function iterm2Sequence(p: Extract<ImagePayload, { protocol: "iterm2" }>, fit: Fit): string {
  return `\x1b]1337;File=inline=1;size=${p.size};width=${fit.cols};height=${fit.rows};preserveAspectRatio=1:${p.data}\x07`
}

/**
 * The image whole, to print at the cursor (the inline transcript): Sixel's bands from its first
 * row, kitty's pixels shown as they are sent (scaled into the cells, the cursor not moving),
 * iTerm2's file in its box.
 */
export function inlineImage(p: ImagePayload, fit: Fit): ImageBlock {
  let seq: string
  if (p.protocol === "sixel")
    seq = `${sixelHead(p.width, p.height)}${p.palette}${(p.phases[0] ?? []).join("-")}\x1b\\`
  else if (p.protocol === "kitty")
    seq = kittyChunks(`a=T,f=32,s=${p.width},v=${p.height},c=${fit.cols},r=${fit.rows},o=z,C=1,q=2`, p.data)
  else seq = iterm2Sequence(p, fit)
  return { seq, cols: fit.cols, rows: fit.rows }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
/** Sixel data: printable ASCII only, so nothing in it can end the image or start another sequence. */
const SIXEL = /^[ -~]*$/

/**
 * Whether a payload from a provider is what it says: the right protocol, sizes that are whole
 * numbers, and data that cannot carry escape sequences (Sixel printable ASCII, base64 for the
 * others). What fails is not drawn.
 */
export function validPayload(p: unknown, protocol: string): p is ImagePayload {
  if (!p || typeof p !== "object") return false
  const v = p as Record<string, unknown>
  if (v.protocol !== protocol) return false
  const size = (n: unknown) => Number.isInteger(n) && (n as number) >= 1
  if (v.protocol === "iterm2") return size(v.size) && typeof v.data === "string" && BASE64.test(v.data)
  if (!size(v.width) || !size(v.height)) return false
  if (v.protocol === "kitty") return typeof v.data === "string" && BASE64.test(v.data)
  if (typeof v.palette !== "string" || !SIXEL.test(v.palette)) return false
  const phases = v.phases as Record<string, unknown> | undefined
  if (!phases || typeof phases !== "object" || !Array.isArray(phases[0])) return false
  for (const [k, bands] of Object.entries(phases)) {
    if (!/^[0-5]$/.test(k) || !Array.isArray(bands)) return false
    for (const b of bands) if (typeof b !== "string" || !SIXEL.test(b)) return false
  }
  return true
}
