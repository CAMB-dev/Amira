import { expect, test } from "bun:test"
import { fitImage } from "../src/images/fit.ts"
import { inlineImage, kittyChunks, validPayload } from "../src/images/sequence.ts"
import { ImageStore } from "../src/images/store.ts"
import { fakePayload, fakeProvider } from "./fake-images.ts"

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

test("each protocol's framing of an encoded image, to print whole", () => {
  const fit = { width: 18, height: 18, cols: 2, rows: 1 }
  const sixel = inlineImage(
    {
      protocol: "sixel",
      width: 18,
      height: 18,
      palette: "#0;2;100;100;100",
      phases: { 0: ["#0!18~", "#0!18~", "#0!18~"] },
    },
    fit,
  )
  expect(sixel).toEqual({
    seq: '\x1bP0;1;0q"1;1;18;18#0;2;100;100;100#0!18~-#0!18~-#0!18~\x1b\\',
    cols: 2,
    rows: 1,
  })
  expect(inlineImage({ protocol: "iterm2", data: "iVBOR", size: 4 }, fit).seq).toBe(
    "\x1b]1337;File=inline=1;size=4;width=2;height=1;preserveAspectRatio=1:iVBOR\x07",
  )
  expect(inlineImage({ protocol: "kitty", width: 18, height: 18, data: "eJzt" }, fit).seq).toBe(
    "\x1b_Ga=T,f=32,s=18,v=18,c=2,r=1,o=z,C=1,q=2,m=0;eJzt\x1b\\",
  )
  // Big payloads go in chunks of 4096 base64 characters.
  const chunks = kittyChunks("a=t,i=1", "A".repeat(9000)).split("\x1b\\").filter(Boolean)
  expect(chunks.map((c) => c.slice(0, c.indexOf(";") + 1))).toEqual([
    "\x1b_Ga=t,i=1,m=1;",
    "\x1b_Gm=1;",
    "\x1b_Gm=0;",
  ])
  expect(chunks.map((c) => c.length - c.indexOf(";") - 1)).toEqual([4096, 4096, 808])
})

test("a provider's payload is drawn only when it is what it says, and can carry no escape sequence", () => {
  const fit = { width: 12, height: 12, cols: 2, rows: 1 }
  const sixel = fakePayload({ protocol: "sixel", fit, cellHeight: 20, whole: true })
  expect(validPayload(sixel, "sixel")).toBe(true)
  expect(validPayload(sixel, "kitty")).toBe(false)
  expect(validPayload({ ...sixel, palette: "#0;2;1;1;1\x1b]52;c;cHduZWQ=\x07" }, "sixel")).toBe(false)
  expect(validPayload({ ...sixel, phases: { 0: ["~~\x1b\\\x1b[2J"] } }, "sixel")).toBe(false)
  expect(validPayload({ ...sixel, phases: { 7: ["~"], 0: [] } }, "sixel")).toBe(false)
  expect(validPayload({ ...sixel, width: 0 }, "sixel")).toBe(false)
  expect(validPayload({ protocol: "kitty", width: 1, height: 1, data: "AAAA" }, "kitty")).toBe(true)
  expect(validPayload({ protocol: "kitty", width: 1, height: 1, data: "AA\x07AA" }, "kitty")).toBe(false)
  expect(validPayload({ protocol: "iterm2", data: "AAAA", size: 3 }, "iterm2")).toBe(true)
  expect(validPayload({ protocol: "iterm2", data: "AAAA\x1b\\", size: 3 }, "iterm2")).toBe(false)
  expect(validPayload(null, "sixel")).toBe(false)
  // No more than was reserved: bands without a band break of their own, not more of them than
  // the height has, and no larger than the size it was fitted to.
  expect(validPayload(sixel, "sixel", fit)).toBe(true)
  expect(validPayload({ ...sixel, phases: { 0: ["~~-~~-~~-~~", "~", "~"] } }, "sixel")).toBe(false)
  expect(validPayload({ ...sixel, phases: { 0: ["~", "~", "~"] } }, "sixel")).toBe(false)
  expect(validPayload({ ...sixel, phases: { 0: ['"1;1;9;999~'] } }, "sixel")).toBe(false)
  expect(validPayload({ ...sixel, palette: "#0;2;1;1;1~~~" }, "sixel")).toBe(false)
  expect(validPayload({ ...sixel, height: 13 }, "sixel", fit)).toBe(false)
  expect(validPayload({ protocol: "kitty", width: 99, height: 1, data: "AAAA" }, "kitty", fit)).toBe(false)
})

test("the store: opened once per source, fitted here, encoded by the provider, failures remembered", async () => {
  const p = fakeProvider()
  const store = new ImageStore({
    support: { protocol: "sixel", cell: { width: 10, height: 20 } },
    open: p.open,
    cwd: "/work",
    maxRows: () => 5,
  })
  // 40×60 pixels: 4 columns, 3 rows.
  const block = await store.load("cat-40x60.png", 30)
  expect(block).toMatchObject({ cols: 4, rows: 3 })
  expect(block!.seq).toStartWith('\x1bP0;1;0q"1;1;40;60')
  expect(p.encoded.map((r) => [r.fit, r.whole])).toEqual([
    [{ width: 40, height: 60, cols: 4, rows: 3 }, true],
  ])
  // Again, and narrower: opened once.
  expect(await store.load("cat-40x60.png", 30)).toBe(block)
  expect(await store.load("cat-40x60.png", 2)).toMatchObject({ cols: 2 })
  expect(await store.load("nothing.png", 30)).toBeUndefined()
  expect(await store.load("nothing.png", 30)).toBeUndefined()
  expect(p.opened).toEqual(["cat-40x60.png", "nothing.png"])
  // The full screen's: its size known once opened, each fitted size encoded when wanted.
  const s = store.screen({ url: "cat-40x60.png" })
  await Bun.sleep(0)
  expect(s.state).toBe("ready")
  const img = s.image(30, 5)!
  expect(img.rows).toBe(3)
  await new Promise<void>((r) => img.whenReady(r))
  expect(img.ready).toBe(true)
  expect(p.encoded.at(-1)).toMatchObject({ whole: false, fit: { cols: 4, rows: 3 } })
  expect(s.image(30, 5)).toBe(img)
  // Bytes are told apart by what they hold: a diagram rendered again is the same image.
  const data = new TextEncoder().encode("20x20")
  expect(await store.inline({ data }, 30)).toMatchObject({ cols: 2, rows: 1 })
  expect(await store.inline({ data: new TextEncoder().encode("20x20") }, 30)).toMatchObject({ cols: 2 })
  expect(store.screen({ data: new TextEncoder().encode("20x20") })).toBe(store.screen({ data }))
  expect(p.opened.filter((o) => o === "<data>")).toHaveLength(1)
})

test("the store: what only ran out of time is not remembered, and is asked for again", async () => {
  let delay = 80
  const p = fakeProvider()
  const slow = {
    ...p,
    open: async (...a: Parameters<typeof p.open>) => {
      await Bun.sleep(delay)
      return p.open(...a)
    },
  }
  const store = new ImageStore({
    support: { protocol: "sixel", cell: { width: 10, height: 20 } },
    open: slow.open,
    cwd: "/work",
    maxRows: () => 5,
    timeoutMs: 30,
    openLimitMs: 200,
  })
  // Its turn came late: alt text this time, the image when asked again.
  expect(await store.load("cat-40x60.png", 30)).toBeUndefined()
  await Bun.sleep(100)
  delay = 0
  expect(await store.load("cat-40x60.png", 30)).toMatchObject({ cols: 4, rows: 3 })
  // A provider that never answers is given up on (its signal aborts); the full screen asks again later.
  let signal: AbortSignal | undefined
  const hanging = new ImageStore({
    support: { protocol: "sixel", cell: { width: 10, height: 20 } },
    open: (_input, ctx) => {
      signal = ctx.signal
      return new Promise(() => {})
    },
    cwd: "/work",
    maxRows: () => 5,
    openLimitMs: 40,
  })
  const s = hanging.screen({ url: "x-10x10.png" })
  let settled = false
  s.onSettled(() => {
    settled = true
  })
  await Bun.sleep(80)
  expect(settled).toBe(true)
  expect(s.state).toBe("failed")
  expect(signal?.aborted).toBe(true)
  expect(hanging.screen({ url: "x-10x10.png" })).not.toBe(s)
})

test("the store: a provider that answers with something that is not a payload draws nothing", async () => {
  const store = new ImageStore({
    support: { protocol: "kitty", cell: { width: 10, height: 20 } },
    open: async () => ({
      width: 10,
      height: 10,
      encode: async () => ({ protocol: "kitty", width: 10, height: 10, data: "\x1b]0;pwned\x07" }),
    }),
    cwd: "/work",
    maxRows: () => 5,
  })
  expect(await store.load("x.png", 30)).toBeUndefined()
  const img = store.screen({ url: "x.png" })
  await Bun.sleep(0)
  const image = img.image(30, 5)!
  await new Promise<void>((r) => image.whenReady(r))
  expect(image.broken).toBe(true)
})
