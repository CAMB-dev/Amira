import { deflateSync } from "node:zlib"
import { decodeImage, resizeBitmap } from "./decode.ts"
import type { Fit } from "./fit.ts"
import { quantize, sixelBands, sixelPalette } from "./sixel.ts"

/** An image to get ready for the full-screen view at one fitted size. */
export interface PrepareRequest {
  bytes: Uint8Array
  protocol: "sixel" | "kitty"
  fit: Fit
  /** Cell height in pixels: where each row of cells starts in the image. */
  cellHeight: number
}

/**
 * What drawing any slice of the image needs. Sixel: the palette and, for each phase (a row's
 * first pixel row modulo 6), the bands of six pixel rows from there, so a slice starting at any
 * row is joined from them without encoding again. kitty: the pixels, zlib-compressed, in base64.
 */
export type Prepared =
  | { protocol: "sixel"; width: number; height: number; palette: string; phases: Record<number, string[]> }
  | { protocol: "kitty"; width: number; height: number; data: string }

/** Decodes, scales and encodes the image; slow for large images, so it runs in a worker when it can. */
export function prepareImage(req: PrepareRequest): Prepared {
  const { fit } = req
  const bmp = resizeBitmap(decodeImage(req.bytes), fit.width, fit.height)
  const { width, height } = bmp
  if (req.protocol === "kitty")
    return { protocol: "kitty", width, height, data: Buffer.from(deflateSync(bmp.data)).toString("base64") }
  const { palette, index } = quantize(bmp, 256)
  const phases: Record<number, string[]> = {}
  for (let row = 0; row * req.cellHeight < height; row++) {
    const y = row * req.cellHeight
    const phase = y % 6
    phases[phase] ??= sixelBands(index, width, height, phase)
  }
  return { protocol: "sixel", width, height, palette: sixelPalette(palette), phases }
}

interface Job {
  resolve: (p: Prepared) => void
  reject: (e: Error) => void
  req: PrepareRequest
}

let worker: Worker | undefined
/** Workers cannot be used here (a compiled binary without the module, say): prepare inline. */
let broken = false
let loaded = false
let nextJob = 1
const jobs = new Map<number, Job>()
let workerUrl = new URL("./prepare-worker.ts", import.meta.url).href

function getWorker(): Worker | undefined {
  if (worker || broken) return worker
  try {
    // A compiled binary needs prepare-worker.ts as an extra entrypoint at this relative path.
    const w = new Worker(workerUrl)
    w.unref()
    w.onmessage = (
      e: MessageEvent<
        { id: number; ok: true; prepared: Prepared } | { id: number; ok: false; error: string }
      >,
    ) => {
      loaded = true
      const job = jobs.get(e.data.id)
      if (!job) return
      jobs.delete(e.data.id)
      if (!jobs.size) w.unref()
      if (e.data.ok) job.resolve(e.data.prepared)
      else job.reject(new Error(e.data.error))
    }
    const gone = () => {
      if (worker !== w) return
      worker = undefined
      w.terminate()
      if (!loaded) broken = true
      // What was waiting is prepared here instead (or fails, when the worker died on it).
      const waiting = [...jobs.values()]
      jobs.clear()
      for (const job of waiting) inline(job)
    }
    w.addEventListener("error", gone)
    w.addEventListener("close", gone)
    worker = w
  } catch {
    broken = true
  }
  return worker
}

function inline(job: Job) {
  // A turn later, so what waits for it (a frame showing the alt text) goes first.
  setTimeout(() => {
    try {
      job.resolve(prepareImage(job.req))
    } catch (err) {
      job.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }, 0)
}

/**
 * Prepares an image in a worker, so decoding a large one (hundreds of milliseconds) does not
 * stall input and frames; on this thread when workers cannot run.
 */
export function prepareOffThread(req: PrepareRequest): Promise<Prepared> {
  return new Promise((resolve, reject) => {
    const job = { req, resolve, reject }
    const w = getWorker()
    if (!w) return inline(job)
    const id = nextJob++
    jobs.set(id, job)
    w.ref()
    // A copy goes over; the caller keeps its bytes for other sizes.
    w.postMessage({ id, req })
  })
}

/** For tests: prepare from another worker module (a missing one runs inline), or reset. */
export function resetPrepareWorker(opts: { url?: string } = {}): void {
  worker?.terminate()
  worker = undefined
  broken = false
  loaded = false
  if (opts.url) workerUrl = opts.url
}
