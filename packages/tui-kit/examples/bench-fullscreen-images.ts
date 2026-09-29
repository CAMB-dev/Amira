// Measures the full-screen transcript with images: bun packages/tui-kit/examples/bench-fullscreen-images.ts
//
// A transcript of replies with a 640×480 image each, on a fake 120×40 terminal, drawn by the
// full-screen renderer as Amira draws it. Reports the cost of a frame when nothing changed, of
// scrolling through it row by row and page by page (time per frame, bytes written), per protocol,
// and how long the main thread stalls while a large image is prepared in the worker.
import { encode as encodePng } from "fast-png"
import { type BlockEnv, type BlockImages, LinesBlock, ReplyBlock } from "../../tui/src/blocks.ts"
import { TranscriptPane } from "../../tui/src/transcript-pane.ts"
import { prepareOffThread } from "../src/images/prepare.ts"
import {
  type Component,
  FakeTerminal,
  FullScreenRenderer,
  ImageLoader,
  type ImageProtocol,
  prepareImage,
  type RenderContext,
  defaultTheme as theme,
} from "../src/index.ts"

function png(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - width / 2, y - height / 2) / width
      data.set([(x * 7) & 255, (y * 5) & 255, Math.round(255 * (1 - d)), 255], (y * width + x) * 4)
    }
  return encodePng({ width, height, data, channels: 4 })
}

const IMAGE = png(640, 480)
const REPLIES = 12
const cell = { width: 10, height: 20 }

async function run(protocol: ImageProtocol) {
  const terminal = new FakeTerminal(120, 40)
  const loader = new ImageLoader({
    support: { protocol, cell },
    cwd: process.cwd(),
    fetchRemote: async () => ({ bytes: IMAGE, contentType: "image/png" }),
    maxRows: () => Math.min(20, Math.floor(terminal.rows * 0.4)),
    // Inline here, so the numbers below are the renderer's alone.
    prepare: async (req) => prepareImage(req),
  })
  let frames = 0
  const images: BlockImages = { loader, changed: () => frames++ }
  const pane = new TranscriptPane()
  for (let i = 0; i < REPLIES; i++) {
    pane.add(new LinesBlock("user", () => [`› image ${i + 1}`]))
    const filler = Array.from({ length: 8 }, (_, k) => `text ${i}.${k} to scroll past`).join("\n")
    pane.add(
      new ReplyBlock(`Image ${i + 1}:\n\n![img ${i}](https://img.test/${i}.png)\n\n${filler}`, false, true),
    )
  }
  const env = (width: number): BlockEnv => ({
    theme,
    width,
    now: 0,
    spinner: "",
    detail: "full",
    presenters: undefined,
    hyperlinks: true,
    nodes: new Map(),
    images,
  })
  const root: Component = {
    render(width: number, ctx: RenderContext) {
      const rows = pane.render(env(width), ctx.rows - 4)
      for (const p of pane.placements) ctx.place?.(p)
      return [...rows, "", "input", "status", "hints"]
    },
  }
  const renderer = new FullScreenRenderer(terminal, root)
  renderer.open()
  // Load and prepare everything: scroll through once, waiting for each image.
  const settle = async () => {
    for (let k = 0; k < 50; k++) {
      await Bun.sleep(5)
      renderer.render()
    }
  }
  pane.toTop()
  for (let i = 0; i < 40; i++) {
    renderer.render()
    await settle()
    pane.pageDown()
  }
  pane.toTop()
  renderer.render()
  await settle()

  const frame = () => {
    terminal.clearWrites()
    const t = performance.now()
    renderer.render()
    return { ms: performance.now() - t, bytes: terminal.output.length }
  }
  // Nothing changed, images in view.
  const idle: number[] = []
  let idleBytes = 0
  for (let i = 0; i < 200; i++) {
    const f = frame()
    idle.push(f.ms)
    idleBytes += f.bytes
  }
  const scroll = (step: () => void, n: number) => {
    const ms: number[] = []
    let bytes = 0
    for (let i = 0; i < n; i++) {
      step()
      const f = frame()
      ms.push(f.ms)
      bytes += f.bytes
    }
    ms.sort((a, b) => a - b)
    return {
      frames: n,
      medianMs: ms[Math.floor(n / 2)]!.toFixed(2),
      p95Ms: ms[Math.floor(n * 0.95)]!.toFixed(2),
      maxMs: ms[n - 1]!.toFixed(2),
      kbPerFrame: (bytes / n / 1024).toFixed(1),
    }
  }
  pane.toTop()
  frame()
  const rows = scroll(() => pane.scrollBy(1), 150)
  pane.toTop()
  frame()
  const wheel = scroll(() => pane.scrollBy(3), 60)
  pane.toTop()
  frame()
  const pages = scroll(() => pane.pageDown(), 12)
  idle.sort((a, b) => a - b)
  renderer.close()
  return {
    protocol,
    idleFrame: { medianMs: idle[100]!.toFixed(3), maxMs: idle[199]!.toFixed(3), bytesTotal: idleBytes },
    rowByRow: rows,
    wheel3Rows: wheel,
    pageByPage: pages,
  }
}

for (const protocol of ["sixel", "kitty", "iterm2"] as const) console.log(await run(protocol))

// The main thread while a 2400×1600 JPEG-sized PNG is prepared in the worker: the longest gap
// between timer ticks that should come every 5 ms.
const big = png(2400, 1600)
const fit = { width: 594, height: 396, cols: 60, rows: 20 }
const measureStall = async (prep: () => Promise<unknown>) => {
  let last = performance.now()
  let worst = 0
  const tick = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last)
    last = now
  }, 5)
  const t = performance.now()
  await prep()
  const total = performance.now() - t
  await Bun.sleep(20)
  clearInterval(tick)
  return { totalMs: total.toFixed(0), worstStallMs: worst.toFixed(0) }
}
console.log({
  largeImageInWorker: await measureStall(() =>
    prepareOffThread({ bytes: big, protocol: "sixel", fit, cellHeight: 20 }),
  ),
  largeImageInline: await measureStall(async () => {
    await Bun.sleep(0)
    prepareImage({ bytes: big, protocol: "sixel", fit, cellHeight: 20 })
  }),
})
process.exit(0)
