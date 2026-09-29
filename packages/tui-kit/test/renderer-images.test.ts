import { expect, test } from "bun:test"
import type { Component, RenderContext } from "../src/component.ts"
import { findImageMarker, pendingImage, placeImage } from "../src/images/placement.ts"
import type { ImageBlock } from "../src/images/types.ts"
import { LiveRenderer } from "../src/renderer.ts"
import { FakeTerminal } from "../src/terminal.ts"
import { VirtualScreen } from "./screen.ts"

class Lines implements Component {
  constructor(public lines: string[]) {}
  render(): string[] {
    return this.lines
  }
}

function setup(cols = 30, rows = 12) {
  const term = new FakeTerminal(cols, rows)
  const screen = new VirtualScreen(cols, rows)
  const write = term.write.bind(term)
  term.write = (data: string) => {
    write(data)
    screen.write(data)
  }
  const root = new Lines(["> live"])
  const r = new LiveRenderer(term, root)
  r.start()
  return { term, screen, root, r }
}

/** A Sixel image of `cols`×`rows` cells of 10×20 pixels, in whole bands as `fitImage` makes it. */
const sixel = (cols: number, rows: number): ImageBlock => ({
  seq: `\x1bP0;1;0q"1;1;${cols * 10};${Math.floor((rows * 20) / 6) * 6}#0!${cols * 10}~\x1b\\`,
  cols,
  rows,
})

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test("an image is placed where its line goes, and lines after it wait for it, shown live meanwhile", async () => {
  const { screen, r } = setup()
  const load = deferred<ImageBlock | undefined>()
  r.commit(["before", `  ${pendingImage(load.promise, ["🖼\uFE0F cat"])}`, "after 1"])
  // Waiting: the fallback and what follows are at the top of the live region, not committed.
  expect(screen.lines.slice(0, 4)).toEqual(["before", "  🖼\uFE0F cat", "after 1", "> live"])
  r.commit(["after 2"])
  expect(screen.lines.slice(0, 5)).toEqual(["before", "  🖼\uFE0F cat", "after 1", "after 2", "> live"])
  expect(screen.images).toEqual([])
  load.resolve(sixel(4, 3))
  await Bun.sleep(30)
  expect(screen.images).toEqual([{ protocol: "sixel", row: 1, col: 2, rows: 3, cols: 4 }])
  expect(screen.lines.slice(0, 7)).toEqual([
    "before",
    "  ▓▓▓▓",
    "  ▓▓▓▓",
    "  ▓▓▓▓",
    "after 1",
    "after 2",
    "> live",
  ])
  // Drawn once: later frames leave it alone.
  r.commit(["later"])
  r.render()
  expect(screen.images.length).toBe(1)
  expect(screen.lines.slice(4, 8)).toEqual(["after 1", "after 2", "later", "> live"])
})

test("at the bottom of the screen the image makes its rows first, so drawing it never scrolls it", async () => {
  const { screen, r } = setup(30, 6)
  r.commit(["1", "2", "3", "4"])
  r.commit([pendingImage(Promise.resolve(sixel(3, 4)), ["🖼\uFE0F x"])])
  await Bun.sleep(20)
  r.commit(["next"])
  // The image's cells are exactly between the line before and the line after it.
  const all = [...screen.scrollback, ...screen.lines]
  const at = all.indexOf("4")
  expect(all.slice(at, at + 6)).toEqual(["4", "▓▓▓", "▓▓▓", "▓▓▓", "▓▓▓", "next"])
  expect(screen.images[0]!.row).toBe(at + 1)
})

test("an image that fails, or takes longer than its time, is committed as its fallback", async () => {
  const { screen, r } = setup()
  r.commit([pendingImage(Promise.reject(new Error("404")), ["🖼\uFE0F gone"]), "a"])
  await Bun.sleep(10)
  r.render()
  const slow = deferred<ImageBlock | undefined>()
  r.commit([pendingImage(slow.promise, ["🖼\uFE0F slow"], 40), "b"])
  expect(screen.lines.slice(0, 4)).toEqual(["🖼\uFE0F gone", "a", "🖼\uFE0F slow", "b"])
  await Bun.sleep(100)
  // Committed now: a live line added after it stays below it.
  slow.resolve(sixel(2, 2))
  await Bun.sleep(20)
  expect(screen.images).toEqual([])
  expect(screen.lines.slice(0, 5)).toEqual(["🖼\uFE0F gone", "a", "🖼\uFE0F slow", "b", "> live"])
})

test("lines waiting that would not fit on the screen let the image go as its fallback", async () => {
  const { screen, r } = setup(30, 6)
  const load = deferred<ImageBlock | undefined>()
  r.commit([pendingImage(load.promise, ["🖼\uFE0F big"]), "l1", "l2", "l3"])
  expect(screen.images).toEqual([])
  r.commit(["l4", "l5"])
  // Six rows of waiting lines and the live one do not fit in six: nothing waits any more.
  expect(screen.text).toBe(["🖼\uFE0F big", "l1", "l2", "l3", "l4", "l5", "> live"].join("\n"))
  load.resolve(sixel(2, 2))
  await Bun.sleep(20)
  expect(screen.images).toEqual([])
})

test("an image wider than the terminal when it is ready goes as its fallback; stop does not wait", async () => {
  const { screen, r, term } = setup(10, 8)
  r.commit([pendingImage(Promise.resolve(sixel(12, 2)), ["🖼\uFE0F wide"])])
  await Bun.sleep(20)
  r.render()
  expect(screen.images).toEqual([])
  expect(screen.lines[0]).toBe("🖼\uFE0F wide")
  const never = deferred<ImageBlock | undefined>()
  r.commit([pendingImage(never.promise, ["🖼\uFE0F never"]), "tail"])
  r.stop()
  expect(screen.text).toBe(["🖼\uFE0F wide", "🖼\uFE0F never", "tail", "> live"].join("\n"))
  expect(term.output).not.toContain("tk:img")
})

test("an image as tall as the screen when it is ready goes as its fallback", async () => {
  const { screen, r } = setup(30, 6)
  r.commit([pendingImage(Promise.resolve(sixel(3, 6)), ["🖼\uFE0F tall"]), "next"])
  await Bun.sleep(20)
  r.render()
  expect(screen.images).toEqual([])
  expect(screen.lines.slice(0, 3)).toEqual(["🖼\uFE0F tall", "next", "> live"])
})

test("an image marker is honored only as registered; content cannot forge or carry one", () => {
  const { screen, r, term } = setup()
  const marker = pendingImage(Promise.resolve(undefined), ["x"])
  const forged = `${marker.slice(0, marker.lastIndexOf(":"))}:999999\x07`
  expect(findImageMarker(forged)).toBeUndefined()
  r.commit([`text ${forged} more`])
  expect(term.output).not.toContain("tk:img")
  expect(screen.lines[0]).toBe("text  more")
})

test("a marker committed where it is never printed is forgotten", () => {
  const { r } = setup()
  let kept: RenderContext | undefined
  r.stop()
  const late = pendingImage(new Promise(() => {}), ["late"])
  r.commit([late])
  expect(findImageMarker(late)).toBeUndefined()
  // Through a context kept past its frame.
  const term = new FakeTerminal(30, 12)
  const r2 = new LiveRenderer(term, {
    render: (_w, ctx) => {
      kept = ctx
      return ["> live"]
    },
  })
  r2.start()
  const stale = pendingImage(new Promise(() => {}), ["stale"])
  kept!.commit!([stale])
  expect(findImageMarker(stale)).toBeUndefined()
  r2.stop()
})

test("placing an image makes its rows, then draws it with the cursor saved around it", () => {
  expect(placeImage({ seq: "IMG", cols: 3, rows: 2 }, 4)).toBe("\r\n\r\n\x1b[2A\x1b[5G\x1b7IMG\x1b8\x1b[1B")
  expect(placeImage({ seq: "IMG", cols: 3, rows: 1 }, 0)).toBe("\r\n\x1b[1A\x1b[1G\x1b7IMG\x1b8")
})

test("redraw draws committed images again when they still fit, else their fallback", async () => {
  const { screen, r, term } = setup(20, 12)
  r.commit(["top", pendingImage(Promise.resolve(sixel(4, 2)), ["🖼\uFE0F pic"]), "bottom"])
  await Bun.sleep(20)
  r.render()
  expect(screen.images.length).toBe(1)
  r.redraw()
  expect(screen.images.length).toBe(2)
  expect(screen.lines.slice(0, 5)).toEqual(["top", "▓▓▓▓", "▓▓▓▓", "bottom", "> live"])
  term.setSize(3, 12)
  screen.resize(3, 12)
  r.redraw()
  expect(screen.images.length).toBe(2)
  // Not re-wrapped by this screen, as a terminal that got narrower may: the fallback's row wraps.
  expect(screen.lines.slice(0, 4)).toEqual(["top", "🖼\uFE0F", "pic", "bot"])
})
