import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encode as encodePng } from "fast-png"
import type { Component, RenderContext } from "../src/component.ts"
import { FullScreenRenderer } from "../src/fullscreen.ts"
import { type ImageProtocol, iterm2Image } from "../src/images/encode.ts"
import { fitImage } from "../src/images/fit.ts"
import { ImageLoader } from "../src/images/loader.ts"
import { prepareImage, prepareOffThread, resetPrepareWorker } from "../src/images/prepare.ts"
import { type ImagePlacement, ScreenImage, setScreenImageBudget } from "../src/images/screen.ts"
import { FakeTerminal } from "../src/terminal.ts"
import { VirtualScreen } from "./screen.ts"

const CELL = { width: 10, height: 20 }

/** A PNG of `width`×`height` pixels in two colors, top and bottom half. */
function png(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const top = i < (width * height) / 2
    data.set(top ? [200, 30, 30, 255] : [30, 30, 200, 255], i * 4)
  }
  return encodePng({ width, height, data, channels: 4 })
}

/** An image of 4×3 cells (40×60 pixels), ready to draw with `protocol`. */
async function image(protocol: ImageProtocol = "sixel", bytes = png(40, 60)): Promise<ScreenImage> {
  const img = unprepared(protocol, bytes)
  await new Promise<void>((r) => img.whenReady(r))
  return img
}

/** The same, not prepared until wanted; `prepared` counts how often it was. */
function unprepared(protocol: ImageProtocol = "sixel", bytes = png(40, 60)) {
  const fit = fitImage({ width: 40, height: 60 }, 30, 20, CELL)!
  const img = new ScreenImage(protocol, fit, CELL.height, async () => {
    counts.prepared++
    if (protocol === "iterm2") return { protocol, seq: iterm2Image(bytes, fit) }
    return prepareImage({ bytes, protocol, fit, cellHeight: CELL.height })
  })
  return img
}
const counts = { prepared: 0 }

/** Rows of text and images placed over them, as a view hands them to the renderer. */
class Scene implements Component {
  places: ImagePlacement[] = []
  constructor(public lines: string[]) {}
  render(_width: number, ctx: RenderContext): string[] {
    for (const p of this.places) ctx.place?.(p)
    return this.lines
  }
}

function setup(cols = 20, rows = 8) {
  const term = new FakeTerminal(cols, rows)
  const screen = new VirtualScreen(cols, rows)
  const write = term.write.bind(term)
  term.write = (data: string) => {
    write(data)
    screen.write(data)
  }
  const scene = new Scene(["title", "", "", "", "", "after", "", "bottom"])
  const full = new FullScreenRenderer(term, scene)
  const resize = (c: number, r: number) => {
    screen.resize(c, r)
    term.setSize(c, r)
  }
  return { term, screen, scene, full, resize }
}

const at = (img: ScreenImage, row: number, from = 0, to = img.rows, col = 2): ImagePlacement => ({
  image: img,
  row,
  col,
  from,
  to,
  key: "a",
})

test("Sixel: drawn at its place after the text, then left alone while it stays there", async () => {
  const { term, screen, scene, full } = setup()
  const img = await image()
  scene.places = [at(img, 1)]
  full.open()
  expect(screen.images).toEqual([
    expect.objectContaining({ protocol: "sixel", screenRow: 1, col: 2, rows: 3, cols: 4 }),
  ])
  expect(screen.lines.slice(0, 6)).toEqual(["title", "  ▓▓▓▓", "  ▓▓▓▓", "  ▓▓▓▓", "", "after"])
  // Nothing changed: nothing is written at all.
  term.clearWrites()
  full.render()
  expect(term.output).toBe("")
  // Other rows change: only they are written, the image is not sent again.
  scene.lines = ["title 2", "", "", "", "", "after", "", "bottom"]
  full.render()
  expect(screen.images.length).toBe(1)
  expect(term.output).not.toContain("\x1bP")
  expect(screen.lines.slice(0, 4)).toEqual(["title 2", "  ▓▓▓▓", "  ▓▓▓▓", "  ▓▓▓▓"])
})

test("Sixel: moved, the rows it left are erased and it is drawn at its new place", async () => {
  const { screen, scene, full } = setup()
  const img = await image()
  scene.places = [at(img, 2)]
  full.open()
  scene.places = [at(img, 1)]
  full.render()
  expect(screen.images.map((i) => i.screenRow)).toEqual([2, 1])
  expect(screen.lines.slice(0, 6)).toEqual(["title", "  ▓▓▓▓", "  ▓▓▓▓", "  ▓▓▓▓", "", "after"])
})

test("Sixel: no longer placed (scrolled off, covered), its pixels are erased, text rows unchanged or not", async () => {
  const { screen, scene, full } = setup()
  scene.places = [at(await image(), 1)]
  full.open()
  scene.places = []
  full.render()
  // The rows' text did not change, yet they were written again: that is what clears the pixels.
  expect(screen.lines.slice(0, 6)).toEqual(["title", "", "", "", "", "after"])
})

test("Sixel: partly in view, the slice of rows in view is drawn, never reaching the row below", async () => {
  const { term, screen, scene, full } = setup()
  const img = await image()
  // Its first row is scrolled off above: rows 1 and 2 of it at the top of the screen.
  scene.lines = ["", "", "rest", "", "", "", "", ""]
  scene.places = [at(img, 0, 1, 3)]
  full.open()
  expect(screen.images).toEqual([expect.objectContaining({ screenRow: 0, rows: 2, cols: 4 })])
  expect(screen.lines.slice(0, 3)).toEqual(["  ▓▓▓▓", "  ▓▓▓▓", "rest"])
  // Pixel rows 20 to 56 (whole bands of six that fit in two rows), not 60.
  expect(term.output).toContain('q"1;1;40;36')
  // The same slice again is not encoded again: the same sequence is sent.
  const first = term.output.slice(term.output.indexOf("\x1bP"), term.output.indexOf("\x1b\\") + 2)
  scene.places = []
  full.render()
  term.clearWrites()
  scene.places = [at(img, 0, 1, 3)]
  full.render()
  expect(term.output).toContain(first)
})

test("an image is never drawn on the last row (Sixel would scroll the screen): it is cut above it", async () => {
  const { screen, scene, full } = setup(20, 5)
  scene.lines = ["a", "b", "", "", ""]
  scene.places = [at(await image(), 2)]
  full.open()
  expect(screen.images).toEqual([expect.objectContaining({ screenRow: 2, rows: 2 })])
  expect(screen.lines).toEqual(["a", "b", "  ▓▓▓▓", "  ▓▓▓▓", ""])
})

test("Sixel: a row under the image written over (a selection mark) has the image drawn again", async () => {
  const { screen, scene, full } = setup()
  const img = await image()
  scene.places = [at(img, 1)]
  full.open()
  scene.lines = ["title", "▌", "", "", "", "after", "", "bottom"]
  full.render()
  expect(screen.images.length).toBe(2)
  expect(screen.lines.slice(1, 4)).toEqual(["▌ ▓▓▓▓", "  ▓▓▓▓", "  ▓▓▓▓"])
})

test("a resize clears the screen and draws the images again", async () => {
  const { screen, scene, full, resize } = setup()
  const img = await image()
  scene.places = [at(img, 1)]
  full.open()
  resize(24, 8)
  full.render()
  expect(screen.images.length).toBe(2)
  expect(screen.lines.slice(0, 4)).toEqual(["title", "  ▓▓▓▓", "  ▓▓▓▓", "  ▓▓▓▓"])
})

test("iTerm2: drawn whole only; partly in view it is not drawn (the view shows its alt text)", async () => {
  const { screen, scene, full } = setup()
  const img = await image("iterm2")
  scene.places = [at(img, 1)]
  full.open()
  expect(screen.images).toEqual([
    expect.objectContaining({ protocol: "iterm2", screenRow: 1, rows: 3, cols: 4 }),
  ])
  scene.places = [at(img, 0, 1, 3)]
  full.render()
  expect(screen.images.length).toBe(1)
  expect(screen.lines.slice(0, 5)).toEqual(["title", "", "", "", ""])
})

test("kitty: sent once under its id, placed, moved by placing it again, cropped, removed and freed", async () => {
  const { term, screen, scene, full } = setup()
  const img = await image("kitty")
  scene.places = [at(img, 1)]
  full.open()
  expect(screen.kittyLog).toEqual([`t i=${img.id}`, `p i=${img.id} p=1`])
  expect([...screen.kittyPlacements.values()]).toEqual([
    { id: img.id, pid: 1, row: 1, col: 2, rows: 3, cols: 4 },
  ])
  // Unchanged: nothing is written.
  term.clearWrites()
  full.render()
  expect(term.output).toBe("")
  // Scrolled by a row: the same placement again, one row up; nothing sent, nothing deleted.
  scene.places = [at(img, 0)]
  full.render()
  expect(screen.kittyLog.slice(2)).toEqual([`p i=${img.id} p=1`])
  expect(screen.kittyPlacements.get(`${img.id}:1`)).toMatchObject({ row: 0, rows: 3 })
  // Partly in view: the terminal crops the pixels it was sent.
  scene.places = [at(img, 0, 1, 3)]
  full.render()
  expect(screen.kittyPlacements.get(`${img.id}:1`)).toEqual({
    id: img.id,
    pid: 1,
    row: 0,
    col: 2,
    rows: 2,
    cols: 4,
    y: 20,
    h: 40,
  })
  // Gone from view: the placement is deleted, the pixels kept for when it comes back.
  scene.places = []
  full.render()
  expect(screen.kittyLog.at(-1)).toBe(`d:i i=${img.id} p=1`)
  expect(screen.kittyPlacements.size).toBe(0)
  scene.places = [at(img, 1)]
  full.render()
  expect(screen.kittyLog.filter((l) => l.startsWith("t "))).toHaveLength(1)
  expect(screen.kittyPlacements.size).toBe(1)
  // Leaving the screen frees it.
  full.close()
  expect(screen.kittyLog.at(-1)).toBe(`d:I i=${img.id}`)
  expect(screen.kittyImages.size).toBe(0)
})

test("kitty: a redraw takes every placement away and places them again; two occurrences get two", async () => {
  const { screen, scene, full } = setup()
  const img = await image("kitty")
  scene.places = [at(img, 0), { ...at(img, 4), key: "b" }]
  full.open()
  expect(screen.kittyPlacements.size).toBe(2)
  full.redraw()
  expect(screen.kittyLog.slice(3)).toEqual(["d:a i=0", `p i=${img.id} p=1`, `p i=${img.id} p=2`])
  expect(screen.kittyPlacements.size).toBe(2)
})

test("an image not ready yet is not drawn; it is once a frame finds it ready", async () => {
  const { screen, scene, full } = setup()
  const img = unprepared()
  const before = counts.prepared
  scene.places = [at(img, 1)]
  full.open()
  expect(screen.images).toEqual([])
  // Nothing is prepared until it is wanted.
  expect(counts.prepared).toBe(before)
  let told = 0
  await new Promise<void>((r) =>
    img.whenReady(() => {
      told++
      r()
    }),
  )
  expect(told).toBe(1)
  expect(counts.prepared).toBe(before + 1)
  full.render()
  expect(screen.images).toEqual([expect.objectContaining({ screenRow: 1, rows: 3 })])
})

test("images past the shared budget let go of what they hold, and are prepared again when wanted", async () => {
  const a = await image()
  const b = await image()
  const before = counts.prepared
  // Used over a second ago (off screen): let go of once b holds more than allowed.
  a.usedAt -= 5000
  setScreenImageBudget(1)
  try {
    b.draw(0, 3)
    expect(a.ready).toBe(false)
    expect(a.draw(0, 3)).toBeUndefined()
    // b was used just now (on screen): kept, over budget or not.
    expect(b.ready).toBe(true)
    await new Promise<void>((r) => a.whenReady(r))
    expect(a.ready).toBe(true)
    expect(counts.prepared).toBe(before + 1)
  } finally {
    setScreenImageBudget(96 * 1024 * 1024)
  }
})

test("a preparation that waited while nobody wanted the image is skipped, and done when it is wanted again", async () => {
  const fit = fitImage({ width: 40, height: 60 }, 30, 20, CELL)!
  let runs = 0
  let gate!: () => void
  const img = new ScreenImage("sixel", fit, CELL.height, async (wanted) => {
    await new Promise<void>((r) => {
      gate = r
    })
    if (!wanted()) return null
    runs++
    return prepareImage({ bytes: png(40, 60), protocol: "sixel", fit, cellHeight: CELL.height })
  })
  let told = 0
  img.whenReady(() => told++)
  img.usedAt -= 5000
  gate()
  await Bun.sleep(5)
  expect(runs).toBe(0)
  expect(img.ready).toBe(false)
  // Those waiting heard of it: a view still showing it wants it again.
  expect(told).toBe(1)
  img.want()
  gate()
  await Bun.sleep(5)
  expect(img.ready).toBe(true)
  expect(runs).toBe(1)
})

const dir = mkdtempSync(join(tmpdir(), "amira-fsimg-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("the loader's screen images: size known once the file is in, each size prepared once, off the thread", async () => {
  writeFileSync(join(dir, "a.png"), png(80, 120))
  let prepared = 0
  const loader = new ImageLoader({
    support: { protocol: "sixel", cell: CELL },
    cwd: dir,
    maxRows: () => 20,
    prepare: (req) => {
      prepared++
      return prepareOffThread(req)
    },
  })
  const source = loader.screen("a.png")!
  expect(loader.screen("a.png")).toBe(source)
  expect(source.state).toBe("loading")
  expect(source.image(30, 20)).toBeUndefined()
  let settled = false
  source.onSettled(() => {
    settled = true
  })
  while (source.state === "loading") await Bun.sleep(5)
  expect(settled).toBe(true)
  expect(source.size).toEqual({ format: "png", width: 80, height: 120 })
  // Synchronously sized: 6 rows at full size, 3 when the screen allows only 3.
  const big = source.image(30, 20)!
  expect([big.cols, big.rows]).toEqual([8, 6])
  expect(source.image(30, 20)).toBe(big)
  const small = source.image(30, 3)!
  expect(small.rows).toBe(3)
  // Prepared only once wanted, each size once.
  expect(prepared).toBe(0)
  await new Promise<void>((r) => big.whenReady(r))
  await new Promise<void>((r) => small.whenReady(r))
  await new Promise<void>((r) => big.whenReady(r))
  expect(prepared).toBe(2)
  expect(big.draw(0, 6)).toStartWith('\x1bP0;1;0q"1;1;80;120')
  // A network path is never read; a missing file fails.
  expect(loader.screen("\\\\host\\share\\x.png")).toBeUndefined()
  const missing = loader.screen("missing.png")!
  while (missing.state === "loading") await Bun.sleep(5)
  expect(missing.state).toBe("failed")
})

test("preparing falls back to this thread when the worker cannot load", async () => {
  resetPrepareWorker({ url: new URL("./fixtures/no-such-worker.ts", import.meta.url).href })
  try {
    const fit = fitImage({ width: 40, height: 60 }, 30, 20, CELL)!
    const p = await prepareOffThread({ bytes: png(40, 60), protocol: "kitty", fit, cellHeight: 20 })
    expect(p).toMatchObject({ protocol: "kitty", width: 40, height: 60 })
    await expect(
      prepareOffThread({ bytes: new Uint8Array([1, 2, 3]), protocol: "sixel", fit, cellHeight: 20 }),
    ).rejects.toThrow()
  } finally {
    resetPrepareWorker({ url: new URL("../src/images/prepare-worker.ts", import.meta.url).href })
  }
})
