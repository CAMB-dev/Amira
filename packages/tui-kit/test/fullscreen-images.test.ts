import { expect, test } from "bun:test"
import type { Component, RenderContext } from "../src/component.ts"
import { FullScreenRenderer } from "../src/fullscreen.ts"
import { fitImage } from "../src/images/fit.ts"
import { type ImagePlacement, ScreenImage, setScreenImageBudget } from "../src/images/screen.ts"
import type { ImageProtocol } from "../src/images/types.ts"
import { FakeTerminal } from "../src/terminal.ts"
import { fakePayload } from "./fake-images.ts"
import { VirtualScreen } from "./screen.ts"

const CELL = { width: 10, height: 20 }

/** An image of 4×3 cells (40×60 pixels), ready to draw with `protocol`. */
async function image(protocol: ImageProtocol = "sixel"): Promise<ScreenImage> {
  const img = unprepared(protocol)
  await new Promise<void>((r) => img.whenReady(r))
  return img
}

/** The same, not prepared until wanted; `prepared` counts how often it was. */
function unprepared(protocol: ImageProtocol = "sixel") {
  const fit = fitImage({ width: 40, height: 60 }, 30, 20, CELL)!
  const img = new ScreenImage(protocol, fit, CELL.height, async () => {
    counts.prepared++
    return fakePayload({ protocol, fit, cellHeight: CELL.height, whole: false })
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
    return fakePayload({ protocol: "sixel", fit, cellHeight: CELL.height, whole: false })
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
