import type {
  EncodeRequest,
  ImageInput,
  ImageOpener,
  ImagePayload,
  OpenedImage,
} from "../src/images/types.ts"

/**
 * A stand-in for an image provider (the images extension, D88), for testing what the kit does
 * with images: sizes come from the source ("cat-40x60.png", or bytes reading "40x60"), and the
 * encoded images are made up, of the fitted size, in each protocol's shape.
 */

/** The size a source names, if it does. */
export function sizeOf(input: ImageInput): { width: number; height: number } | undefined {
  const text = "url" in input ? input.url : new TextDecoder().decode(input.data)
  const m = /(\d+)x(\d+)/.exec(text)
  return m ? { width: Number(m[1]), height: Number(m[2]) } : undefined
}

/** Made-up bands, palette and pixels of the fitted size; every phase a row starts in for Sixel. */
export function fakePayload(req: EncodeRequest): ImagePayload {
  const { width, height } = req.fit
  if (req.protocol === "kitty") return { protocol: "kitty", width, height, data: "AAAA" }
  if (req.protocol === "iterm2") return { protocol: "iterm2", data: "AAAA", size: 3 }
  const phases: Record<number, string[]> = {}
  for (let row = 0; row * req.cellHeight < height; row++) {
    const p = (row * req.cellHeight) % 6
    if (req.whole && p !== 0) continue
    phases[p] ??= Array.from({ length: Math.ceil((height - p) / 6) }, () => "#0!4~")
  }
  return { protocol: "sixel", width, height, palette: "#0;2;100;0;0", phases }
}

export interface FakeProvider {
  open: ImageOpener
  /** Sources opened, in order. */
  opened: string[]
  /** Encodes asked for (and done). */
  encoded: EncodeRequest[]
}

/**
 * Opens the sources that name a size (others fail), after `delayMs`; `encode` answers after
 * `encodeMs`, null when not wanted any more.
 */
export function fakeProvider(opts: { delayMs?: number; encodeMs?: number } = {}): FakeProvider {
  const p: FakeProvider = {
    opened: [],
    encoded: [],
    open: async (input) => {
      p.opened.push("url" in input ? input.url : "<data>")
      if (opts.delayMs) await Bun.sleep(opts.delayMs)
      const size = sizeOf(input)
      if (!size) return undefined
      const image: OpenedImage = {
        ...size,
        encode: async (req) => {
          if (opts.encodeMs) await Bun.sleep(opts.encodeMs)
          if (req.wanted && !req.wanted()) return null
          p.encoded.push(req)
          return fakePayload(req)
        },
      }
      return image
    },
  }
  return p
}
