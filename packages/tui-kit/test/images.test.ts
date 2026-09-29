import { expect, test } from "bun:test"
import { encode as encodePng } from "fast-png"
import { encode as encodeJpeg } from "jpeg-js"
import { GifWriter } from "omggif"
import { decodeImage, imageSize, resizeBitmap, sniffFormat } from "../src/images/decode.ts"
import { encodeImage, iterm2Image, kittyImage } from "../src/images/encode.ts"
import { fitImage } from "../src/images/fit.ts"
import { encodeSixel, quantize } from "../src/images/sixel.ts"

/** A bitmap from 0xRRGGBBAA pixels, row by row. */
function bitmap(width: number, pixels: number[]) {
  const data = new Uint8Array(pixels.length * 4)
  pixels.forEach((p, i) => {
    data[i * 4] = p >>> 24
    data[i * 4 + 1] = (p >>> 16) & 255
    data[i * 4 + 2] = (p >>> 8) & 255
    data[i * 4 + 3] = p & 255
  })
  return { width, height: pixels.length / width, data }
}

test("Sixel: a tiny image, byte for byte", () => {
  // Red, green / blue, transparent.
  const bmp = bitmap(2, [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0x00000000])
  expect(encodeSixel(bmp)).toBe('\x1bP0;1;0q"1;1;2;2#0;2;100;0;0#1;2;0;100;0#2;2;0;0;100#0@$#1?@$#2A\x1b\\')
  // Two bands, a run-length encoded row, and a trailing empty run left out.
  const wide = bitmap(6, [
    ...Array(6 * 6).fill(0xffffffff),
    0xffffffff,
    0xffffffff,
    0xffffffff,
    0xffffffff,
    0x00000000,
    0x00000000,
  ])
  expect(encodeSixel(wide)).toBe('\x1bP0;1;0q"1;1;6;7#0;2;100;100;100#0!6~-#0!4@\x1b\\')
})

test("Sixel: more colors than the palette holds are reduced to it, and dithered", () => {
  const pixels: number[] = []
  for (let i = 0; i < 64 * 64; i++) pixels.push((((i * 2654435761) >>> 0) & 0xffffff00) | 0xff)
  const bmp = bitmap(64, pixels)
  const { palette, index } = quantize(bmp, 16)
  expect(palette.length).toBeLessThanOrEqual(16)
  expect(Math.max(...index)).toBeLessThan(palette.length)
  expect(Math.min(...index)).toBe(0)
  const seq = encodeSixel(bmp, { maxColors: 16 })
  expect(seq).toStartWith('\x1bP0;1;0q"1;1;64;64#0;2;')
  expect(seq).not.toContain("#16;")
  expect(seq).toEndWith("\x1b\\")
  // 64 rows are 11 bands.
  expect(seq.split("-").length).toBe(11)
})

test("fitting: never enlarged, aspect kept, rows counted in whole Sixel bands", () => {
  const cell = { width: 10, height: 20 }
  // Small enough already: kept at its size.
  expect(fitImage({ width: 35, height: 30 }, 80, 20, cell)).toEqual({
    width: 35,
    height: 30,
    cols: 4,
    rows: 2,
  })
  // Too wide: 800×400 into 40 columns (400 px).
  // 200 px would end in a band reaching into an 11th row, so it is 198 px (33 bands).
  expect(fitImage({ width: 800, height: 400 }, 40, 20, cell)).toEqual({
    width: 396,
    height: 198,
    cols: 40,
    rows: 10,
  })
  // Too tall: 10 rows are 200 px, less the part of a band.
  expect(fitImage({ width: 100, height: 1000 }, 80, 10, cell)).toEqual({
    width: 20,
    height: 198,
    cols: 2,
    rows: 10,
  })
  // 36 px in 16 px rows: 3 rows, and its 6 bands fit in them.
  expect(fitImage({ width: 10, height: 36 }, 80, 20, { width: 8, height: 16 })).toEqual({
    width: 10,
    height: 36,
    cols: 2,
    rows: 3,
  })
  // For any size, the rows cover the height rounded up to whole bands, and no more.
  for (let h = 1; h <= 200; h++) {
    const f = fitImage({ width: 50, height: h }, 80, 4, { width: 8, height: 17 })!
    expect(f.rows).toBeLessThanOrEqual(4)
    expect(Math.ceil(f.height / 6) * 6).toBeLessThanOrEqual(f.rows * 17)
    expect(f.rows).toBe(Math.ceil(f.height / 17))
  }
  expect(fitImage({ width: 10, height: 10 }, 0, 5, cell)).toBeUndefined()
})

test("formats are told by their signature, and their size read from the header", () => {
  const png = encodePng({ width: 3, height: 2, data: new Uint8Array(3 * 2 * 4).fill(200), channels: 4 })
  expect(imageSize(png)).toEqual({ format: "png", width: 3, height: 2 })
  const jpeg = encodeJpeg({ width: 5, height: 4, data: Buffer.alloc(5 * 4 * 4, 128) }, 90).data
  expect(imageSize(jpeg)).toEqual({ format: "jpeg", width: 5, height: 4 })
  const gif = gifOf(4, 3)
  expect(imageSize(gif)).toEqual({ format: "gif", width: 4, height: 3 })
  const webp = new Uint8Array(30)
  webp.set(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8X"), 0)
  webp.set([9, 0, 0, 4, 0, 0], 24)
  expect(imageSize(webp)).toEqual({ format: "webp", width: 10, height: 5 })
  expect(sniffFormat(new TextEncoder().encode("<svg xmlns=..."))).toBeUndefined()
})

function gifOf(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(1024)
  const w = new GifWriter(buf, width, height, { palette: [0xff0000, 0x0000ff] })
  w.addFrame(
    0,
    0,
    width,
    height,
    Array.from({ length: width * height }, (_, i) => i % 2),
  )
  return buf.subarray(0, w.end())
}

test("PNG, JPEG and GIF decode to RGBA", () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128])
  expect(decodeImage(encodePng({ width: 2, height: 1, data: rgba, channels: 4 })).data).toEqual(rgba)
  // Gray with alpha, 16 bits.
  const gray = encodePng({
    width: 1,
    height: 1,
    data: new Uint16Array([0x8000, 0xffff]),
    channels: 2,
    depth: 16,
  })
  expect([...decodeImage(gray).data]).toEqual([128, 128, 128, 255])
  const gif = decodeImage(gifOf(2, 1))
  expect([...gif.data]).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
  const jpeg = decodeImage(encodeJpeg({ width: 8, height: 8, data: Buffer.alloc(256, 255) }, 90).data)
  expect(jpeg.width).toBe(8)
  expect(jpeg.data[3]).toBe(255)
  expect(() => decodeImage(new TextEncoder().encode("GIF"))).toThrow()
})

test("shrinking averages the pixels each target pixel covers, weighted by alpha", () => {
  const bmp = bitmap(2, [0xff0000ff, 0x00000000, 0x0000ffff, 0x0000ffff])
  expect([...resizeBitmap(bmp, 1, 1).data]).toEqual([85, 0, 170, 191])
})

test("each protocol's encoding, sized to fit", () => {
  const png = encodePng({ width: 40, height: 40, data: new Uint8Array(40 * 40 * 4).fill(255), channels: 4 })
  const opts = { maxCols: 2, maxRows: 5, cell: { width: 10, height: 20 } }
  const sixel = encodeImage(png, { ...opts, protocol: "sixel" })!
  expect({ cols: sixel.cols, rows: sixel.rows }).toEqual({ cols: 2, rows: 1 })
  // 20 px would take 24 px of bands, reaching into a second row: 18×18 then.
  expect(sixel.seq).toStartWith('\x1bP0;1;0q"1;1;18;18#0;2;100;100;100')
  const iterm = encodeImage(png, { ...opts, protocol: "iterm2" })!
  expect(iterm.seq).toBe(iterm2Image(png, { width: 18, height: 18, cols: 2, rows: 1 }))
  expect(iterm.seq).toStartWith(
    `\x1b]1337;File=inline=1;size=${png.length};width=2;height=1;preserveAspectRatio=1:iVBOR`,
  )
  const kitty = encodeImage(png, { ...opts, protocol: "kitty" })!
  expect(kitty.seq).toStartWith("\x1b_Ga=T,f=32,s=18,v=18,o=z,C=1,q=2,m=0;")
  // Big payloads go in chunks of 4096 base64 characters.
  const noisy = bitmap(
    64,
    Array.from({ length: 64 * 64 }, (_, i) => ((i * 2654435761) >>> 0) | 0xff),
  )
  const chunks = kittyImage(noisy).split("\x1b\\").filter(Boolean)
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks[1]).toStartWith("\x1b_Gm=")
  expect(chunks.at(-1)).toStartWith("\x1b_Gm=0;")
  // WebP needs a decoder only iTerm2's protocol has.
  const webp = new Uint8Array(30)
  webp.set(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8X"), 0)
  expect(() => encodeImage(webp, { ...opts, protocol: "sixel" })).toThrow("webp")
})
