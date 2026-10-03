import { expect, test } from "bun:test"
import type {
  AnyEvent,
  ExtensionAPI,
  MarkdownNode,
  MarkdownRenderContext,
  OpenedImage,
  ToolLine,
} from "@amira/api"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ImageProviderRegistry, MarkdownRendererRegistry, ServiceRegistry } from "../src/render-registry.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const ctx: MarkdownRenderContext = { width: 40, images: false, maxImageRows: 10, theme: { dark: true } }
const math = (display = false, source = "x^2"): MarkdownNode => ({ type: "math", display, source })
const code = (lang: string, text = "graph TD; A-->B"): MarkdownNode => ({
  type: "code",
  lang,
  info: lang,
  code: text,
})
const image: MarkdownNode = { type: "image", url: "a.png", alt: "a" }

function newHost() {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  return { bus, events, host }
}

test("markdown renderers: matched by language (any case) or image, highest priority first, then registration order", () => {
  const r = new MarkdownRendererRegistry()
  const seen: string[] = []
  const add = (
    id: string,
    priority?: number,
    match: { codeLang: string[] } | { image: true } = { codeLang: ["Mermaid"] },
  ) =>
    r.register({
      id,
      match,
      ...(priority !== undefined ? { priority } : {}),
      render: () => {
        seen.push(id)
        return undefined
      },
    })
  add("a")
  add("b", 5)
  add("c")
  add("img", 0, { image: true })
  expect(r.claimsCode("MERMAID")).toBe(true)
  expect(r.claimsCode("js")).toBe(false)
  expect(r.claimsCode("")).toBe(false)
  expect(r.claimsImages).toBe(true)
  expect(r.render(code("mermaid"), ctx)).toBeUndefined()
  expect(seen).toEqual(["b", "a", "c"])
  seen.length = 0
  r.render(image, ctx)
  expect(seen).toEqual(["img"])
  expect(r.render(code("python"), ctx)).toBeUndefined()
})

test("the first result wins; one that throws or rejects is reported once and the next is asked", async () => {
  const errors: string[] = []
  const r = new MarkdownRendererRegistry((source, error) => errors.push(`${source}: ${error}`))
  r.register(
    {
      id: "boom",
      priority: 3,
      match: { codeLang: ["x"] },
      render: () => {
        throw new Error("bad")
      },
    },
    "ext:a",
  )
  r.register(
    {
      id: "later",
      priority: 2,
      match: { codeLang: ["x"] },
      render: async () => Promise.reject(new Error("worse")),
    },
    "ext:b",
  )
  r.register(
    {
      id: "ok",
      priority: 1,
      match: { codeLang: ["x"] },
      render: async () => ({ lines: [{ kind: "code", text: "drawn" }] }),
    },
    "ext:c",
  )
  r.register(
    { id: "never", match: { codeLang: ["x"] }, render: () => ({ lines: [{ kind: "text", text: "no" }] }) },
    "ext:d",
  )
  const out = r.render(code("x"), ctx)
  expect(out).toBeInstanceOf(Promise)
  expect(await out).toEqual({ lines: [{ kind: "code", text: "drawn" }] })
  await r.render(code("x"), ctx)
  expect(errors).toEqual([
    'ext:a: markdown renderer "boom" failed: bad',
    'ext:b: markdown renderer "later" failed: worse',
  ])
})

test("results are checked: plain text only, a row per line, known kinds; images by URL or bytes", () => {
  const r = new MarkdownRendererRegistry()
  let result: unknown
  r.register({ id: "r", match: { codeLang: ["x"] }, render: () => result as never })
  result = {
    lines: [
      { kind: "bogus", text: "a\x1b[31mred\x1b[0m\nb\tc\x07" },
      { kind: "accent", text: 5 },
    ],
  }
  expect(r.render(code("x"), ctx)).toEqual({
    lines: [
      { kind: "text", text: "ared" },
      { kind: "text", text: "b  c" },
      { kind: "accent", text: "5" },
    ],
  })
  result = { image: { url: "https://x.test/a.png", extra: 1 } }
  expect(r.render(code("x"), { ...ctx, images: true })).toEqual({ image: { url: "https://x.test/a.png" } })
  const data = new Uint8Array([1, 2])
  result = { image: { data, mimeType: "image/png" } }
  expect(r.render(code("x"), { ...ctx, images: true })).toEqual({ image: { data, mimeType: "image/png" } })
  result = { nonsense: true }
  expect(r.render(code("x"), ctx)).toBeUndefined()
})

test("wait times as asked (0 too, nonsense as the default); a runaway rendering is cut and reported", () => {
  const errors: string[] = []
  const r = new MarkdownRendererRegistry((_s, e) => errors.push(e))
  r.register({ id: "now", match: { codeLang: ["a"] }, waitMs: 0, render: () => undefined })
  r.register({ id: "odd", match: { codeLang: ["b"] }, waitMs: Number.NaN, render: () => undefined })
  expect(r.waitMs(code("a"))).toBe(0)
  expect(r.waitMs(code("b"))).toBe(3000)
  r.register({
    id: "flood",
    match: { codeLang: ["c"] },
    render: () => ({ lines: Array.from({ length: 5000 }, () => ({ kind: "text" as const, text: "x" })) }),
  })
  const out = r.render(code("c"), ctx) as { lines: unknown[] }
  expect(out.lines).toHaveLength(2000)
  expect(errors).toEqual([
    'markdown renderer "flood" failed: render returned more than 2000 lines; the rest were left out',
  ])
})

test("renderers need an id, a match and a function; unregistering bumps the version", () => {
  const r = new MarkdownRendererRegistry()
  const render = () => undefined
  expect(() => r.register({ id: "", match: { image: true }, render })).toThrow("needs an id")
  expect(() => r.register({ id: "x", match: {} as never, render })).toThrow("needs match")
  expect(() => r.register({ id: "x", match: { codeLang: [""] }, render })).toThrow("needs match")
  const v = r.version
  const off = r.register({ id: "x", match: { codeLang: ["m"] }, render, waitMs: 99_000 })
  expect(() => r.register({ id: "x", match: { codeLang: ["m"] }, render })).toThrow("already registered")
  expect(r.waitMs(code("m"))).toBe(15_000)
  expect(r.waitMs(code("other"))).toBe(3000)
  expect(r.version).toBeGreaterThan(v)
  off()
  expect(r.size).toBe(0)
  expect(r.claimsCode("m")).toBe(false)
})

test("math matches inline, display or both without claiming images or code", () => {
  const r = new MarkdownRendererRegistry()
  const seen: string[] = []
  const add = (id: "inline" | "display" | "both", priority = 0, waitMs = 0) =>
    r.register({
      id,
      match: { math: id },
      priority,
      waitMs,
      render: () => {
        seen.push(id)
        return undefined
      },
    })
  expect(r.claimsMath(false)).toBe(false)
  expect(r.claimsMath(true)).toBe(false)
  const off = add("inline")
  expect(r.claimsMath(false)).toBe(true)
  expect(r.claimsMath(true)).toBe(false)
  add("display", 0, 100)
  add("both", 5, 50)
  expect(r.claimsMath(true)).toBe(true)
  expect(r.claimsImages).toBe(false)
  expect(r.claimsCode("math")).toBe(false)
  r.render(math(), ctx)
  expect(seen).toEqual(["both", "inline"])
  seen.length = 0
  r.render(math(true), ctx)
  expect(seen).toEqual(["both", "display"])
  expect(r.waitMs(math())).toBe(50)
  expect(r.waitMs(math(true))).toBe(100)
  seen.length = 0
  r.render(image, ctx)
  r.render(code("math"), ctx)
  expect(seen).toEqual([])
  off()
  expect(r.claimsMath(false)).toBe(true)
  expect(() => r.register({ id: "bad", match: { math: "other" } as never, render: () => undefined })).toThrow(
    "needs match",
  )
})

test("inline math uses sanitized styled segments on one line and rejects block results", async () => {
  const errors: string[] = []
  const r = new MarkdownRendererRegistry((_source, error) => errors.push(error))
  let result: unknown
  r.register({ id: "inline", match: { math: "inline" }, render: async () => result as never })
  r.register({
    id: "next",
    match: { math: "inline" },
    render: () => ({ segments: [{ kind: "text", text: "next" }] }),
  })
  result = {
    segments: [
      { kind: "accent", text: "x\x1b[31m²\x1b[0m\r\n+\t1\x07" },
      { kind: "unknown", text: 5 },
    ],
  }
  expect(await r.render(math(), ctx)).toEqual({
    segments: [
      { kind: "accent", text: "x² +  1" },
      { kind: "text", text: "5" },
    ],
  })
  for (const bad of [
    { lines: [{ kind: "text", text: "block" }] },
    { image: { url: "math.png" }, alt: "x²", fallback: [{ kind: "text", text: "x²" }] },
    { segments: [], image: { url: "math.png" } },
    { segments: [], lines: [] },
  ]) {
    result = bad
    expect(await r.render(math(), ctx)).toEqual({ segments: [{ kind: "text", text: "next" }] })
    expect(await r.render(math(), { ...ctx, images: true })).toEqual({
      segments: [{ kind: "text", text: "next" }],
    })
  }
  expect(errors).toHaveLength(1)
  expect(errors[0]).toContain("must return { segments }")
})

test("display math, code and images reject segments and accept block lines", () => {
  for (const node of [math(true), code("x"), image]) {
    const r = new MarkdownRendererRegistry()
    const match =
      node.type === "math"
        ? { math: "display" as const }
        : node.type === "image"
          ? { image: true as const }
          : { codeLang: ["x"] }
    let result: unknown = { segments: [{ kind: "text", text: "inline" }] }
    r.register({ id: "block", match, render: () => result as never })
    expect(r.render(node, ctx)).toBeUndefined()
    result = { segments: [], lines: [] }
    expect(r.render(node, ctx)).toBeUndefined()
    result = { lines: [{ kind: "code", text: "x²" }] }
    expect(r.render(node, ctx)).toEqual({ lines: [{ kind: "code", text: "x²" }] })
  }
})

test("image results preserve sanitized alternatives and use them when images are disabled", async () => {
  const r = new MarkdownRendererRegistry()
  let result: unknown = {
    image: { url: "math.png" },
    alt: "x\x1b[31m²\x1b[0m\r\n+\t1\x07",
    fallback: [
      { kind: "accent", text: "x²\n+\x1b[31m1\x1b[0m" },
      { kind: "invalid", text: "\x07ok" },
    ],
  }
  r.register({ id: "math", match: { math: "display" }, render: async () => result as never })
  const fallback: ToolLine[] = [
    { kind: "accent", text: "x²" },
    { kind: "accent", text: "+1" },
    { kind: "text", text: "ok" },
  ]
  expect(await r.render(math(true), { ...ctx, images: true })).toEqual({
    image: { url: "math.png" },
    alt: "x² +  1",
    fallback,
  })
  expect(await r.render(math(true), ctx)).toEqual({ lines: fallback })
  result = { image: { data: new Uint8Array([1]), mimeType: "image/png" }, alt: "x\x07²" }
  expect(await r.render(math(true), ctx)).toEqual({ lines: [{ kind: "text", text: "x²" }] })
  result = { image: { url: "math.png" }, fallback: [], alt: "unused" }
  expect(await r.render(math(true), ctx)).toEqual({ lines: [] })
  result = { image: { url: "math.png" } }
  expect(await r.render(math(true), ctx)).toBeUndefined()
  r.register({ id: "next", match: { math: "display" }, render: () => ({ lines: [] }) })
  expect(await r.render(math(true), ctx)).toEqual({ lines: [] })
})

test("image fallbacks retain the existing 2000-line cap", () => {
  const errors: string[] = []
  const r = new MarkdownRendererRegistry((_source, error) => errors.push(error))
  r.register({
    id: "flood",
    match: { math: "display" },
    render: () => ({ image: { url: "math.png" }, fallback: [{ kind: "text", text: "x\n".repeat(2500) }] }),
  })
  const out = r.render(math(true), ctx) as { lines: unknown[] }
  expect(out.lines).toHaveLength(2000)
  const graphical = r.render(math(true), { ...ctx, images: true }) as { fallback: unknown[] }
  expect(graphical.fallback).toHaveLength(2000)
  expect(errors).toHaveLength(1)
  expect(errors[0]).toContain("more than 2000 lines")
})

test("each renderer receives an isolated node, context and theme, including async handoff", async () => {
  const r = new MarkdownRendererRegistry()
  const original: MarkdownRenderContext = {
    ...ctx,
    theme: { dark: true, foreground: "#ffffff", background: "#000000" },
  }
  const node = math(true)
  r.register({
    id: "mutate",
    match: { math: "display" },
    render: async (received, context) => {
      if (received.type === "math") received.source = "changed"
      context.width = 1
      context.theme.dark = false
      context.theme.foreground = "changed"
      delete context.theme.background
      return undefined
    },
  })
  r.register({
    id: "observe",
    match: { math: "display" },
    render: (received, context) => {
      expect(received).toEqual(math(true))
      expect(context).toEqual({ ...ctx, theme: { dark: true, foreground: "#ffffff", background: "#000000" } })
      expect(context).not.toBe(original)
      expect(context.theme).not.toBe(original.theme)
      return { lines: [] }
    },
  })
  expect(await r.render(node, original)).toEqual({ lines: [] })
  expect(node).toEqual(math(true))
  expect(original.theme).toEqual({ dark: true, foreground: "#ffffff", background: "#000000" })
})

test("image providers: highest priority first; one that fails or opens nothing hands over to the next", async () => {
  const r = new ImageProviderRegistry()
  const opened: OpenedImage = { width: 10, height: 20, encode: async () => null }
  const asked: string[] = []
  const provider = (id: string, open: () => Promise<OpenedImage | undefined>, priority = 0) =>
    r.register({
      id,
      priority,
      open: () => {
        asked.push(id)
        return open()
      },
    })
  provider("low", async () => opened)
  provider("high", () => Promise.reject(new Error("404")), 2)
  provider("mid", async () => ({ width: 0, height: 5, encode: async () => null }), 1)
  const signal = new AbortController().signal
  expect(await r.open({ url: "a.png" }, { protocol: "sixel", cwd: ".", signal })).toBe(opened)
  expect(asked).toEqual(["high", "mid", "low"])
  const aborted = AbortSignal.abort()
  expect(await r.open({ url: "a.png" }, { protocol: "sixel", cwd: ".", signal: aborted })).toBeUndefined()
})

test("services: one extension offers a name at a time; others look it up, and it goes when its extension unloads", async () => {
  const { host, events, bus } = newHost()
  const render = async () => new Uint8Array([1])
  let user: ExtensionAPI | undefined
  await host.load((api) => {
    user = api
  }, "ext:user")
  expect(user!.useService("browser.renderHtmlToPng")).toBeUndefined()
  await host.load((api) => void api.provideService("browser.renderHtmlToPng", render), "ext:browser")
  expect(user!.useService("browser.renderHtmlToPng")).toBe(render)
  await host.load(
    (api) => void api.provideService("browser.renderHtmlToPng", async () => new Uint8Array()),
    "ext:other",
  )
  await bus.flush()
  expect(
    events.some(
      (e) =>
        e.type === "extension.error" && JSON.stringify(e.data).includes("already offered by ext:browser"),
    ),
  ).toBe(true)
  // The other extension still loaded: only its offer was skipped.
  expect(host.loaded).toContain("ext:other")
  expect(user!.useService("browser.renderHtmlToPng")).toBe(render)
  expect(user!.useService<string>("custom.thing")).toBeUndefined()
  host.unload("ext:browser")
  expect(user!.useService("browser.renderHtmlToPng")).toBeUndefined()
  expect(new ServiceRegistry().names).toEqual([])
})

test("extensions register markdown renderers and image providers through the host; unloading removes them", async () => {
  const { host, events, bus } = newHost()
  await host.load((api) => {
    api.registerMarkdownRenderer({ id: "m", match: { codeLang: ["mermaid"] }, render: () => undefined })
    api.registerMarkdownRenderer({ id: "m", match: { codeLang: ["mermaid"] }, render: () => undefined })
    api.registerImageProvider({ id: "p", open: async () => undefined })
  }, "ext:r")
  await bus.flush()
  expect(host.markdown.size).toBe(1)
  expect(host.images.size).toBe(1)
  expect(events.filter((e) => e.type === "extension.error")).toHaveLength(1)
  host.unload("ext:r")
  expect(host.markdown.size).toBe(0)
  expect(host.images.size).toBe(0)
})
