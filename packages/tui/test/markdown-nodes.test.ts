import { expect, test } from "bun:test"
import type { MarkdownNode, MarkdownRenderContext, MarkdownRenderResult } from "@amira/api"
import { MarkdownRendererRegistry } from "@amira/core"
import { defaultTheme, ImageStore, renderMarkdown, stripAnsi } from "@amira/tui-kit"
import { findImageMarker, imageState, releaseImage } from "../../tui-kit/src/images/placement.ts"
import { fakeProvider } from "../../tui-kit/test/fake-images.ts"
import { setImageFallback } from "../src/blocks/base.ts"
import { type BlockEnv, imagesIn, ReplyBlock } from "../src/blocks.ts"
import { inlineNodes, ReplyRenderers } from "../src/markdown-nodes.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"

const math: MarkdownNode = { type: "math", display: true, source: "x^2" }
const context: MarkdownRenderContext = {
  width: 40,
  images: false,
  maxImageRows: 0,
  theme: { dark: true },
}
const text = [{ kind: "text" as const, text: "x²" }]
const alternative = [
  { kind: "text" as const, text: "x squared" },
  { kind: "text" as const, text: "equals y" },
]
const picture: MarkdownRenderResult = {
  image: { url: "math-40x60.png" },
  alt: "Equation: x squared equals y",
  fallback: alternative,
}

function registry(result: MarkdownRenderResult | Promise<MarkdownRenderResult>) {
  const source = new MarkdownRendererRegistry()
  source.register({ id: "math", match: { math: "both" }, render: () => result })
  return source
}

function store(open = fakeProvider().open) {
  return new ImageStore({
    support: { protocol: "sixel", cell: { width: 10, height: 20 } },
    cwd: "/work",
    maxRows: () => 10,
    open,
  })
}

function env(renders: ReplyRenderers, images?: ImageStore): BlockEnv {
  return {
    theme: defaultTheme,
    width: 40,
    now: 0,
    spinner: "*",
    detail: "summary",
    presenters: undefined,
    hyperlinks: false,
    nodes: new Map(),
    renders: { renders, changed: () => {} },
    ...(images ? { images: { store: images, changed: () => {} } } : {}),
  }
}

const plain = (rows: string[]) => rows.map(stripAnsi).join("\n")

test("math renderers receive the session theme and distinct inline/display contexts", () => {
  const contexts: MarkdownRenderContext[] = []
  const source = new MarkdownRendererRegistry()
  source.register({
    id: "math",
    match: { math: "both" },
    render(node, ctx) {
      contexts.push(ctx)
      return node.type === "math" && !node.display ? { segments: text } : { lines: text }
    },
  })
  const renders = new ReplyRenderers(source, "light")
  const nodes = inlineNodes({ renders, images: () => undefined, theme: defaultTheme })
  expect(plain(renderMarkdown("A $x^2$ B\n\n$$\nx^2\n$$", 40, defaultTheme, { nodes }))).toBe("A x² B\n\nx²")
  expect(contexts).toHaveLength(2)
  expect(contexts.every((ctx) => !ctx.images && !ctx.theme.dark)).toBe(true)
  const block = new ReplyBlock("A \\(x^2\\) B\n\n\\[x^2\\]", false, false)
  expect(plain(block.lines(env(renders)))).toBe("  A x² B\n\n  x²")
})

test("rendering cache distinguishes theme and preserves inline segment spaces", () => {
  const contexts: MarkdownRenderContext[] = []
  const source = new MarkdownRendererRegistry()
  source.register({
    id: "theme",
    match: { math: "both" },
    render(_node, ctx) {
      contexts.push(ctx)
      return { lines: text }
    },
  })
  const renders = new ReplyRenderers(source)
  renders.get(math, context)
  renders.get(math, context)
  renders.get(math, { ...context, theme: { dark: false, foreground: "#111", background: "#fff" } })
  expect(contexts.map((ctx) => ctx.theme)).toEqual([
    { dark: true },
    { dark: false, foreground: "#111", background: "#fff" },
  ])
  const nodes = inlineNodes({
    renders: new ReplyRenderers(
      registry({
        segments: [
          { kind: "accent", text: "x " },
          { kind: "text", text: "+ y" },
        ],
      }),
    ),
    images: () => undefined,
    theme: defaultTheme,
  })
  expect(plain(renderMarkdown("$x+y$", 40, defaultTheme, { nodes }))).toBe("x + y")
})

test("unclaimed or invalid inline math leaves the existing Markdown output unchanged", () => {
  for (const source of [new MarkdownRendererRegistry(), registry(picture)]) {
    const renders = new ReplyRenderers(source)
    const nodes = inlineNodes({ renders, images: () => undefined, theme: defaultTheme })
    const input = "Raw $x_y$ and \\(x^2\\); `$z$` and \\$5."
    expect(renderMarkdown(input, 40, defaultTheme, { nodes })).toEqual(renderMarkdown(input, 40))
  }
})

test("inline image results retain fallback text, including asynchronous results", async () => {
  for (const async of [false, true]) {
    const images = store()
    const renders = new ReplyRenderers(registry(async ? Promise.resolve(picture) : picture))
    const nodes = inlineNodes({ renders, images: () => images, theme: defaultTheme })
    const rows = renderMarkdown("$$x^2$$", 40, defaultTheme, { nodes })
    const marker = findImageMarker(rows[0]!)!
    expect(marker).toBeDefined()
    await renders.get(math, { ...context, images: true, maxImageRows: 10 }).promise
    await images.inline({ url: "math-40x60.png" }, 40)
    await Bun.sleep(0)
    expect(imageState(marker.id)).toMatchObject({ kind: "image", fallback: ["x squared", "equals y"] })
    releaseImage(marker.id)
  }
})

test("image failure and no-graphics paths use fallback lines, or alt alone", async () => {
  for (const result of [picture, { image: { url: "missing.png" }, alt: "formula" }]) {
    const expected = "fallback" in result ? "x squared\nequals y" : "formula"
    const renders = new ReplyRenderers(registry(result))
    const nodes = inlineNodes({ renders, images: () => undefined, theme: defaultTheme })
    expect(plain(renderMarkdown("$$x^2$$", 40, defaultTheme, { nodes }))).toBe(expected)
    const images = store(async () => undefined)
    const graphicNodes = inlineNodes({ renders, images: () => images, theme: defaultTheme })
    const rows = renderMarkdown("$$x^2$$", 40, defaultTheme, { nodes: graphicNodes })
    const marker = findImageMarker(rows[0]!)!
    await Bun.sleep(5)
    expect(imageState(marker.id)).toMatchObject({ kind: "fallback", fallback: expected.split("\n") })
    releaseImage(marker.id)
  }
})

test("an async renderer supplies fallback before image loading times out", async () => {
  const images = store(() => new Promise(() => {}))
  const renders = new ReplyRenderers(registry(Promise.resolve(picture)))
  const nodes = inlineNodes({ renders, images: () => images, theme: defaultTheme })
  const rows = renderMarkdown("$$x^2$$", 40, defaultTheme, { nodes })
  const marker = findImageMarker(rows[0]!)!
  await Bun.sleep(0)
  expect(imageState(marker.id, Number.POSITIVE_INFINITY)).toEqual({
    kind: "fallback",
    fallback: ["x squared", "equals y"],
  })
  releaseImage(marker.id)
})

test("full-screen images retain accessible alt and text for selection, copying and printout", async () => {
  const images = store()
  const renders = new ReplyRenderers(registry(picture))
  const block = new ReplyBlock("$$x^2$$", false, false)
  block.lines(env(renders, images))
  await images.inline({ url: "math-40x60.png" }, 38)
  const rows = block.lines(env(renders, images))
  expect(imagesIn(rows)?.[0]).toMatchObject({
    alt: "Equation: x squared equals y",
    fallback: ["x squared", "equals y"],
  })
  expect(block.copyText()).toBe("x squared\nequals y")
  expect(block.copyRows(rows.map(stripAnsi), rows).some((row) => row.text === "x squared\nequals y")).toBe(
    true,
  )
  expect(plain(block.printLines(env(renders)))).toBe("  x squared\n  equals y")
})

test("full-screen image placeholders use fallback lines without overflowing their viewport", () => {
  const rows = new Map<number, string>()
  setImageFallback(rows, 3, { col: 2, alt: "equation", fallback: ["x squared", "equals y", "hidden"] }, 2, 12)
  expect([...rows.entries()]).toEqual([
    [3, "  x squared"],
    [4, "  equals y"],
  ])
  setImageFallback(rows, 8, { col: 2, alt: "equation", fallback: ["very long fallback"] }, 1, 10)
  expect(rows.get(8)).toBe("  very lo…")
})

test("failed full-screen image encoding relayouts all fallback rows", async () => {
  const images = store(async () => ({
    width: 10,
    height: 10,
    encode: async () => {
      throw new Error("cannot encode")
    },
  }))
  const renders = new ReplyRenderers(registry(picture))
  const block = new ReplyBlock("$$x^2$$", false, false)
  const pane = new TranscriptPane()
  pane.add(block)
  const view = env(renders, images)
  pane.render(view, 8)
  await Bun.sleep(0)
  pane.render(view, 8)
  await Bun.sleep(0)
  expect(plain(pane.render(view, 8))).toContain("  x squared\n  equals y")
})

test("full-screen async inline segments redraw when ready", async () => {
  let resolve!: (result: MarkdownRenderResult) => void
  const renders = new ReplyRenderers(
    registry(
      new Promise((done) => {
        resolve = done
      }),
    ),
  )
  const block = new ReplyBlock("A $x^2$ B", true, false)
  let redraws = 0
  const view = env(renders)
  view.renders!.changed = () => {
    redraws++
  }
  expect(plain(block.lines(view))).toBe("  A $x^2$ B")
  resolve({ segments: text })
  await Bun.sleep(0)
  expect(redraws).toBeGreaterThan(0)
  expect(plain(block.lines(view))).toBe("  A x² B")
})
