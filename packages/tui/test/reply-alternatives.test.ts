import { expect, test } from "bun:test"
import type { MarkdownRenderResult } from "@amira/api"
import { MarkdownRendererRegistry } from "@amira/core"
import { defaultTheme, ImageStore, stripAnsi } from "@amira/tui-kit"
import { fakeProvider } from "../../tui-kit/test/fake-images.ts"
import { type BlockEnv, imagesIn, ReplyBlock } from "../src/blocks.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"

const alternative = "A complete alternative much longer than a narrow terminal can display"
const picture: MarkdownRenderResult = {
  image: { url: "math-40x60.png" },
  alt: "Accessible equation",
  fallback: [{ kind: "accent", text: alternative }],
}
const plain = (rows: string[]) => rows.map(stripAnsi).join("\n")

function setup(result = picture) {
  const registry = new MarkdownRendererRegistry()
  registry.register({ id: "math", match: { math: "display" }, render: () => result })
  registry.register({ id: "code", match: { codeLang: ["diagram"] }, render: () => result })
  registry.register({ id: "image", match: { image: true }, render: () => result })
  const renders = new ReplyRenderers(registry)
  const images = new ImageStore({
    support: { protocol: "sixel", cell: { width: 10, height: 20 } },
    cwd: "/work",
    maxRows: () => 10,
    open: fakeProvider().open,
  })
  const env: BlockEnv = {
    theme: defaultTheme,
    width: 18,
    now: 0,
    spinner: "*",
    detail: "summary",
    presenters: undefined,
    hyperlinks: false,
    nodes: new Map(),
    renders: { renders, changed: () => {} },
    images: { store: images, changed: () => {} },
  }
  return { registry, renders, images, env }
}

test("copy substitutes only resolved image nodes and retains untruncated text", () => {
  const { env } = setup()
  const before = "# Heading\n\n[linked](https://example.com) and `code`\n\n```js\nconst x = 1\n```\n\n"
  const block = new ReplyBlock(`${before}$$x^2$$\n\nTail **bold**`, false, false)
  block.lines(env)
  expect(block.copyText()).toBe(`${before}${alternative}\n\nTail **bold**`)
})

test("no-graphics copy retains image alternatives for math, fenced code and standalone images", () => {
  const { env } = setup()
  delete env.images
  for (const source of ["$$x^2$$", "```diagram\nx -> y\n```", "![original](a.png)"]) {
    const block = new ReplyBlock(`Before\n\n${source}\n\nAfter`, false, false)
    block.lines(env)
    expect(block.copyText()).toBe(`Before\n\n${alternative}\n\nAfter`)
  }
})

test("ordinary text-rendered code still copies its original fenced source", () => {
  const { env } = setup({ lines: [{ kind: "text", text: "rendered diagram" }] })
  delete env.images
  const source = "```diagram\nx -> y\n```"
  const block = new ReplyBlock(source, false, false)
  block.lines(env)
  expect(block.copyText()).toBe(source)
})

test("image selection uses raw fallback rather than display-truncated rows", async () => {
  const { env, images } = setup()
  const block = new ReplyBlock("$$x^2$$", false, false)
  block.lines(env)
  await images.inline({ url: "math-40x60.png" }, 16)
  const rows = block.lines(env)
  expect(imagesIn(rows)?.[0]?.fallback).toEqual([alternative])
  expect(block.copyRows(rows.map(stripAnsi), rows).some((row) => row.text === alternative)).toBe(true)
})

test("copy and print retain alternatives after renderer cache eviction without starting renders", () => {
  const { registry, renders, env } = setup()
  let pending = false
  let calls = 0
  registry.register({
    id: "evicted",
    priority: 10,
    match: { math: "display" },
    render: () => {
      calls++
      return pending ? new Promise(() => {}) : picture
    },
  })
  const block = new ReplyBlock("$$x^2$$", false, false)
  block.lines(env)
  for (let i = 0; i < 260; i++)
    renders.get(
      { type: "math", source: `${i}`, display: true },
      {
        width: 16,
        images: true,
        maxImageRows: 10,
        theme: renders.theme,
      },
    )
  pending = true
  calls = 0
  expect(block.copyText()).toBe(alternative)
  expect(plain(block.printLines({ ...env, width: 100 }))).toBe(`  ${alternative}`)
  expect(calls).toBe(0)
})

test("async image alternatives are retained when they resolve, before another frame", async () => {
  const { registry, env } = setup()
  let resolve!: (result: MarkdownRenderResult) => void
  registry.register({
    id: "async",
    priority: 10,
    match: { math: "display" },
    render: () =>
      new Promise((done) => {
        resolve = done
      }),
  })
  const block = new ReplyBlock("$$x^2$$", false, false)
  block.lines(env)
  resolve(picture)
  await Bun.sleep(0)
  expect(block.copyText()).toBe(alternative)
  const { renders: _, images: __, ...text } = env
  expect(plain(block.printLines({ ...text, width: 100 }))).toBe(`  ${alternative}`)
})

test("alt-only images preserve complete text with and without graphics", () => {
  for (const graphics of [true, false]) {
    const { env } = setup({ image: { url: "math.png" }, alt: alternative })
    if (!graphics) delete env.images
    const block = new ReplyBlock("$$x^2$$", false, false)
    block.lines(env)
    expect(block.copyText()).toBe(alternative)
  }
})

test("copy matches image and fence sources without changing lookalikes or reference definitions", () => {
  const { env } = setup()
  delete env.images
  const prefix = "```text\n![original](a.png)\n$$x^2$$\n```\n\nInline ![original](a.png) stays.\n\n"
  const block = new ReplyBlock(
    `${prefix}![original][picture]\n\n~~~diagram options\nx -> y\n~~~\n\n[picture]: a.png`,
    false,
    false,
  )
  block.lines(env)
  // A forward reference is not rendered until its definition has been seen by the stream.
  expect(block.copyText()).toBe(`${prefix}![original][picture]\n\n${alternative}\n\n[picture]: a.png`)
  const defined = new ReplyBlock(`[picture]: a.png\n\n![original][picture]`, false, false)
  defined.lines(env)
  expect(defined.copyText()).toBe(`[picture]: a.png\n\n${alternative}`)
})

test("copy leaves unclaimed list and quote images alone when replacing another image", () => {
  const { env } = setup({
    image: { url: "math.png" },
    fallback: [
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ],
  })
  delete env.images
  for (const source of ["- ![original](a.png)", "> ![original](a.png)"]) {
    const block = new ReplyBlock(`${source}\n\n![original](a.png)`, false, false)
    block.lines(env)
    expect(block.copyText()).toBe(`${source}\n\nfirst\nsecond`)
  }
})

test("folded print uses supplied width and theme and normal unfolded details", () => {
  const { env } = setup()
  const block = new ReplyBlock(
    "<details>\n<summary>Proof</summary>\n\n$$x^2$$\n\nBody **text**\n</details>",
    false,
    false,
  )
  block.lines(env)
  block.toggleFold()
  block.lines(env)
  const printed = block.printLines({
    ...env,
    width: 100,
    theme: { ...defaultTheme, accent: (text) => `NEW(${text})` },
  })
  expect(plain(printed)).toContain(`NEW(${alternative})`)
  expect(plain(printed)).toContain("▾ Proof")
  expect(plain(printed)).not.toContain("<details>")
  expect(plain(printed)).toContain("Body text")
  expect(block.isFolded()).toBe(true)
})
