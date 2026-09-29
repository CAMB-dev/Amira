import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encode as encodePng } from "fast-png"
import { stripAnsi } from "../src/ansi.ts"
import type { RenderContext } from "../src/component.ts"
import { MarkdownStream } from "../src/components/markdown-stream.ts"
import type { ImageBlock } from "../src/images/encode.ts"
import { ImageLoader, localPath } from "../src/images/loader.ts"
import { findImageMarker, imageState } from "../src/images/placement.ts"
import { LiveRenderer } from "../src/renderer.ts"
import { FakeTerminal } from "../src/terminal.ts"
import { plain } from "./context.ts"
import { VirtualScreen } from "./screen.ts"

const dir = mkdtempSync(join(tmpdir(), "amira-mdimg-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const png = (w: number, h: number) =>
  encodePng({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(255), channels: 4 })
writeFileSync(join(dir, "cat.png"), png(40, 60))
writeFileSync(join(dir, "notes.txt"), "not an image")
// Noise does not compress: well over 1000 bytes.
writeFileSync(
  join(dir, "big.png"),
  encodePng({
    width: 100,
    height: 100,
    data: Uint8Array.from({ length: 100 * 100 * 4 }, (_, i) => (i * 2654435761) >>> 24),
    channels: 4,
  }),
)

const block = (seq = "IMG"): ImageBlock => ({ seq, cols: 2, rows: 2 })

function committing(): { ctx: RenderContext; committed: string[] } {
  const committed: string[] = []
  return { ctx: { ...plain, commit: (lines) => committed.push(...lines) }, committed }
}

test("an image on a line of its own is committed as an image marker; its alt text shows until then", () => {
  const loads: [string, number][] = []
  const m = new MarkdownStream({
    hyperlinks: false,
    images: {
      load: (url, maxCols) => {
        loads.push([url, maxCols])
        return Promise.resolve(block())
      },
    },
  })
  const { ctx, committed } = committing()
  m.append("Look:\n![a cat](cat.png)")
  // Live, it is its alt text; it is asked for already.
  expect(m.render(30, ctx)).toEqual(["Look:", "🖼 a cat (cat.png)"])
  expect(loads).toEqual([["cat.png", 30]])
  m.append("\n\nafter")
  m.render(30, ctx)
  expect(committed.length).toBe(2)
  expect(committed[0]).toBe("Look:")
  const marker = findImageMarker(committed[1]!)!
  expect(marker.prefix).toBe("")
  expect(imageState(marker.id)).toMatchObject({ kind: "wait", fallback: ["🖼 a cat (cat.png)"] })
  expect(m.take(30)).toEqual(["", "after"])
})

test("only a line that is one image (maybe linked) is shown as the image; indented, it keeps its column", () => {
  const load = () => Promise.resolve(block())
  const rows = (text: string, width = 40) => {
    const m = new MarkdownStream({ hyperlinks: false, images: { load } })
    m.append(text)
    return m.take(width).map((r) => (findImageMarker(r) ? r : stripAnsi(r)))
  }
  expect(findImageMarker(rows("[![CI](b.png)](https://ci.x)")[0]!)).toBeDefined()
  expect(findImageMarker(rows("  ![x](a.png)  ")[0]!)).toBeDefined()
  expect(rows("see ![x](a.png)")).toEqual(["see 🖼 x (a.png)"])
  expect(rows("![x](a.png) ![y](b.png)")).toEqual(["🖼 x (a.png) 🖼 y (b.png)"])
  // A reference not defined has no target to load.
  expect(rows("![x][nope]")).toEqual(["🖼 x"])
  expect(findImageMarker(rows("[r]: r.png\n\n![x][r]")[0]!)).toBeDefined()
  // Under a list item, at the item's text.
  const item = rows("- item\n\n  ![x](a.png)")
  const m = findImageMarker(item[2]!)!
  expect(m.prefix).toBe("  ")
  expect((imageState(m.id) as { fallback: string[] }).fallback.map(stripAnsi)).toEqual(["🖼 x (a.png)"])
  // Without images, never.
  const none = new MarkdownStream({ hyperlinks: false })
  none.append("![x](a.png)")
  expect(none.take(40).map(stripAnsi)).toEqual(["🖼 x (a.png)"])
})

test("a long line starting with an image is not committed in pieces before it ends", () => {
  const m = new MarkdownStream({ hyperlinks: false, images: { load: () => Promise.resolve(block()) } })
  const { ctx, committed } = committing()
  m.maxRows = 1
  m.append("![a very long alt text that wraps](https://x.dev/a/very/long/path/to/the/image.png")
  m.render(12, ctx)
  expect(committed).toEqual([])
  m.append(")\n\n")
  m.render(12, ctx)
  expect(findImageMarker(committed[0]!)).toBeDefined()
})

test("through the renderer: the image is drawn in order, between the text around it", async () => {
  const term = new FakeTerminal(30, 12)
  const screen = new VirtualScreen(30, 12)
  const write = term.write.bind(term)
  term.write = (d: string) => {
    write(d)
    screen.write(d)
  }
  const loader = new ImageLoader({
    support: { protocol: "sixel", cell: { width: 10, height: 20 } },
    cwd: dir,
    maxRows: () => 5,
  })
  const m = new MarkdownStream({ hyperlinks: false, images: loader })
  const r = new LiveRenderer(term, m)
  r.start()
  m.append("before\n\n![cat](cat.png)\n\nafter\n\nmore")
  r.render()
  await Bun.sleep(100)
  r.render()
  // 40×60 pixels: 4 columns, 3 rows.
  expect(screen.images).toEqual([{ protocol: "sixel", row: 2, col: 0, rows: 3, cols: 4 }])
  expect(screen.lines.slice(0, 8)).toEqual(["before", "", "▓▓▓▓", "▓▓▓▓", "▓▓▓▓", "", "after", ""])
  r.stop()
})

test("the loader reads local files and checks them; failures and repeats are cached", async () => {
  const loader = new ImageLoader({
    support: { protocol: "iterm2", cell: { width: 10, height: 20 } },
    cwd: dir,
    maxRows: () => 4,
    maxBytes: 1000,
  })
  const cat = await loader.load("cat.png", 80)
  expect(cat).toMatchObject({ cols: 4, rows: 3 })
  expect(cat!.seq).toStartWith("\x1b]1337;File=inline=1;")
  expect(await loader.load(join(dir, "cat.png"), 80)).toEqual(cat)
  expect(await loader.load("cat.png", 2)).toMatchObject({ cols: 2, rows: 2 })
  expect(loader.load("cat.png", 80)).toBe(loader.load("cat.png", 80))
  expect(await loader.load("notes.txt", 80)).toBeUndefined()
  expect(await loader.load("missing.png", 80)).toBeUndefined()
  // Over the size limit.
  expect(await loader.load("big.png", 80)).toBeUndefined()
  expect(await loader.load(".", 80)).toBeUndefined()
  expect(await loader.load("data:image/png;base64,AAAA", 80)).toBeUndefined()
  // No remote fetcher: remote images are not shown.
  expect(await loader.load("https://x.dev/a.png", 80)).toBeUndefined()
})

test("remote images go through the fetcher, which must answer with an image type in time", async () => {
  const calls: string[] = []
  const bytes = png(20, 20)
  const loader = new ImageLoader({
    support: { protocol: "sixel", cell: { width: 10, height: 20 } },
    cwd: dir,
    maxRows: () => 4,
    timeoutMs: 50,
    fetchRemote: async (url, { maxBytes, signal }) => {
      calls.push(`${url.href} ${maxBytes}`)
      if (url.pathname === "/slow.png")
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
      return { bytes, contentType: url.pathname === "/page.png" ? "text/html" : "image/png" }
    },
  })
  expect(await loader.load("https://x.dev/a.png", 80)).toMatchObject({ cols: 2, rows: 1 })
  expect(await loader.load("https://x.dev/a.png", 80)).toMatchObject({ cols: 2, rows: 1 })
  expect(await loader.load("https://x.dev/page.png", 80)).toBeUndefined()
  expect(await loader.load("https://x.dev/slow.png", 80)).toBeUndefined()
  expect(calls).toEqual([
    `https://x.dev/a.png ${10 * 1024 * 1024}`,
    `https://x.dev/page.png ${10 * 1024 * 1024}`,
    `https://x.dev/slow.png ${10 * 1024 * 1024}`,
  ])
})

test("local paths: relative to the working directory, absolute, file: URLs, escapes decoded", () => {
  const cwd = process.platform === "win32" ? "C:\\work" : "/work"
  expect(localPath("img/a%20b.png?x=1", cwd)).toBe(join(cwd, "img", "a b.png"))
  if (process.platform === "win32") {
    expect(localPath("D:\\pics\\a.png", cwd)).toBe("D:\\pics\\a.png")
    expect(localPath("file:///D:/pics/a.png", cwd)).toBe("D:\\pics\\a.png")
  } else expect(localPath("file:///pics/a.png", cwd)).toBe("/pics/a.png")
  expect(localPath("data:image/png;base64,AA", cwd)).toBeUndefined()
})
