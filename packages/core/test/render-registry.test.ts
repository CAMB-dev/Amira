import { expect, test } from "bun:test"
import type { AnyEvent, ExtensionAPI, MarkdownNode, MarkdownRenderContext, OpenedImage } from "@amira/api"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ImageProviderRegistry, MarkdownRendererRegistry, ServiceRegistry } from "../src/render-registry.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const ctx: MarkdownRenderContext = { width: 40, images: false, maxImageRows: 10 }
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
  expect(r.render(code("x"), ctx)).toEqual({ image: { url: "https://x.test/a.png" } })
  const data = new Uint8Array([1, 2])
  result = { image: { data, mimeType: "image/png" } }
  expect(r.render(code("x"), ctx)).toEqual({ image: { data, mimeType: "image/png" } })
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
