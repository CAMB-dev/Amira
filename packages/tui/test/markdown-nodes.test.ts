import { expect, test } from "bun:test"
import type { MarkdownNode, MarkdownRenderContext, MarkdownRenderResult } from "@amira/api"
import { MarkdownRendererRegistry } from "@amira/core"
import { defaultTheme, ImageStore, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { fakeProvider } from "../../tui-kit/test/fake-images.ts"
import { setImageFallback } from "../src/blocks/base.ts"
import { type BlockEnv, imagesIn, ReplyBlock } from "../src/blocks.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"
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
  const displays: boolean[] = []
  const source = new MarkdownRendererRegistry()
  source.register({
    id: "math",
    match: { math: "both" },
    render(node, ctx) {
      contexts.push(ctx)
      if (node.type === "math") displays.push(node.display)
      return node.type === "math" && !node.display ? { segments: text } : { lines: text }
    },
  })
  const renders = new ReplyRenderers(source, "light")
  for (const source of ["A $x^2$ B\n\n$$\nx^2\n$$", "A \\(x^2\\) B\n\n\\[x^2\\]"]) {
    const block = new ReplyBlock(source, false, false)
    expect(plain(block.lines(env(renders)))).toBe("  A x² B\n\n  x²")
  }
  expect(displays).toEqual([false, true])
  expect(contexts).toEqual([
    { ...context, width: 38, theme: { dark: false } },
    { ...context, width: 38, theme: { dark: false } },
  ])
  const block = new ReplyBlock("A $x^2$ B\n\n$$x^2$$", false, false)
  expect(plain(block.lines(env(renders, store())))).toBe("  A x² B\n\n  x²")
  expect(contexts.at(-1)).toEqual({
    ...context,
    width: 38,
    images: true,
    maxImageRows: 10,
    theme: { dark: false },
  })
  expect(displays).toEqual([false, true, true])
})

test("block Markdown choice lines render their retained metadata with wrapping and ANSI styles", () => {
  const renders = new ReplyRenderers(
    registry({
      lines: [
        {
          kind: "text",
          text: "A very long option label with several words",
          marker: "success",
          description: "One explanation",
          wrap: true,
        },
        { kind: "muted", text: "Other", marker: "unchecked", description: "No change" },
        { kind: "text", text: "Plain text also wraps when requested", wrap: true },
      ],
    }),
  )
  const block = new ReplyBlock("$$x^2$$", false, false)
  const rows = block.lines({ ...env(renders), width: 22 })
  expect(rows).toEqual(
    [
      `${defaultTheme.success("✓ ")}${defaultTheme.text("A very long option")}`,
      `  ${defaultTheme.text("label with several")}`,
      `  ${defaultTheme.text("words")}`,
      `  ${defaultTheme.muted("One explanation")}`,
      `${defaultTheme.muted("[ ] ")}${defaultTheme.muted("Other")}${defaultTheme.muted("  No change")}`,
      `${defaultTheme.muted("")}${defaultTheme.text("Plain text also")}`,
      defaultTheme.text("wraps when requested"),
    ].map((row) => `  ${row}`),
  )
  expect(rows.every((row) => visibleWidth(row) <= 22)).toBe(true)
})

test("Markdown multiline choices hang continuations and descriptions under the complete label", () => {
  const renders = new ReplyRenderers(
    registry({
      lines: [
        { kind: "text", text: "First\nsecond", marker: "success", description: "One explanation" },
        { kind: "muted", text: "Else\ncontinued", marker: "unchecked", description: "Not chosen" },
      ],
    }),
  )
  const block = new ReplyBlock("$$x^2$$", false, false)
  for (const width of [20, 90]) {
    const rows = block.lines({ ...env(renders), width: width + 2 })
    expect(rows.map(stripAnsi)).toEqual(
      (width === 90
        ? ["✓ First", "  second  One explanation", "[ ] Else", "    continued  Not chosen"]
        : ["✓ First", "  second", "  One explanation", "[ ] Else", "    continued", "    Not chosen"]
      ).map((row) => `  ${row}`),
    )
    expect(rows[0]).toBe(`  ${defaultTheme.success("✓ ")}${defaultTheme.text("First")}`)
    expect(rows.find((row) => stripAnsi(row).includes("second"))).toContain(defaultTheme.text("second"))
    expect(rows.find((row) => stripAnsi(row).includes("continued"))).toContain(
      defaultTheme.muted("continued"),
    )
    expect(rows.find((row) => stripAnsi(row).includes("One explanation"))).toContain(
      defaultTheme.muted(width === 90 ? "  One explanation" : "One explanation"),
    )
    expect(rows.filter((row) => stripAnsi(row).includes("✓"))).toHaveLength(1)
    expect(rows.filter((row) => stripAnsi(row).includes("[ ]"))).toHaveLength(1)
    expect(rows.every((row) => visibleWidth(row) <= width + 2)).toBe(true)
  }
})

test("description-implied wrapping survives every multiline Markdown-label fragment", () => {
  const label = `${"A ".repeat(40)}\ntail`
  const render = (wrap?: boolean) => {
    const renders = new ReplyRenderers(
      registry({
        lines: [
          { kind: "text", text: label, description: "Explanation", ...(wrap !== undefined ? { wrap } : {}) },
        ],
      }),
    )
    const block = new ReplyBlock("$$x^2$$", false, false)
    return block.lines({ ...env(renders), width: 22 })
  }
  const explicit = render(true)
  for (const wrap of [undefined, false]) {
    const rows = render(wrap)
    const text = rows.map(stripAnsi)
    expect(text.join("\n").match(/A/g)).toHaveLength(40)
    expect(rows).toEqual(explicit)
    expect(text.filter((row) => row.includes("Explanation"))).toHaveLength(1)
    expect(rows[0]).toContain(defaultTheme.text("A A A A A A A A A A"))
    expect(rows.at(-1)).toContain(defaultTheme.text("tail"))
    expect(rows.at(-1)).toContain(defaultTheme.muted("  Explanation"))
    expect(rows.every((row) => visibleWidth(row) <= 22)).toBe(true)
  }
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
  const segments = new ReplyRenderers(
    registry({
      segments: [
        { kind: "accent", text: "x " },
        { kind: "text", text: "+ y" },
      ],
    }),
  )
  const block = new ReplyBlock("$x+y$", false, false)
  expect(plain(block.lines(env(segments)))).toBe("  x + y")
})

test("unclaimed or invalid inline math leaves the existing Markdown output unchanged", () => {
  for (const source of [new MarkdownRendererRegistry(), registry(picture)]) {
    const renders = new ReplyRenderers(source)
    const input = "Raw $x_y$ and \\(x^2\\); `$z$` and \\$5."
    const block = new ReplyBlock(input, false, false)
    const view = env(renders)
    expect(block.lines(view)).toEqual(
      new ReplyBlock(input, false, false).lines({ ...view, renders: undefined }),
    )
  }
})

test("full-screen image results replace fallback text, including asynchronous results", async () => {
  for (const async of [false, true]) {
    let finishOpen!: () => void
    const provider = fakeProvider()
    const images = store(async (...args) => {
      await new Promise<void>((resolve) => {
        finishOpen = resolve
      })
      return provider.open(...args)
    })
    const renders = new ReplyRenderers(registry(async ? Promise.resolve(picture) : picture))
    const block = new ReplyBlock("$$x^2$$", false, false)
    const view = env(renders, images)
    let redraws = 0
    view.renders!.changed = () => {
      redraws++
    }
    let imageRedraws = 0
    view.images!.changed = () => {
      imageRedraws++
    }
    const initial = block.lines(view)
    expect(imagesIn(initial)).toBeUndefined()
    await Bun.sleep(0)
    const fallback = block.lines(view)
    expect(plain(fallback)).toBe("  x squared\n  equals y")
    expect(imagesIn(fallback)).toBeUndefined()
    if (async) expect(redraws).toBeGreaterThan(0)
    else expect(plain(initial)).toBe(plain(fallback))
    finishOpen()
    await Bun.sleep(0)
    expect(imageRedraws).toBeGreaterThan(0)
    const rows = block.lines(view)
    expect(rows).toHaveLength(3)
    expect(imagesIn(rows)).toHaveLength(1)
    expect(imagesIn(rows)?.[0]).toMatchObject({
      alt: "Equation: x squared equals y",
      fallback: ["x squared", "equals y"],
    })
  }
})

test("image failure and no-graphics paths use fallback lines, or alt alone", async () => {
  for (const result of [picture, { image: { url: "missing.png" }, alt: "formula" }]) {
    const expected = "fallback" in result ? "  x squared\n  equals y" : "  formula"
    const renders = new ReplyRenderers(registry(result))
    const block = new ReplyBlock("$$x^2$$", false, false)
    expect(plain(block.lines(env(renders)))).toBe(expected)
    const images = store(async () => undefined)
    const view = env(renders, images)
    expect(plain(block.lines(view))).toBe(expected)
    const source = images.screen(result.image)
    await new Promise<void>((resolve) => source.onSettled(resolve))
    expect(source.state).toBe("failed")
    const rows = block.lines(view)
    expect(plain(rows)).toBe(expected)
    expect(imagesIn(rows)).toBeUndefined()
  }
})

test("an async renderer supplies fallback while a full-screen image is still loading", async () => {
  const images = store(() => new Promise(() => {}))
  const renders = new ReplyRenderers(registry(Promise.resolve(picture)))
  const block = new ReplyBlock("$$x^2$$", false, false)
  const view = env(renders, images)
  block.lines(view)
  await Bun.sleep(0)
  const rows = block.lines(view)
  expect(plain(rows)).toBe("  x squared\n  equals y")
  expect(imagesIn(rows)).toBeUndefined()
  expect(images.screen(picture.image).state).toBe("loading")
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
