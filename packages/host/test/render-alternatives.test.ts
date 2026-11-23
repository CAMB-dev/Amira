import { expect, test } from "bun:test"
import type { MarkdownNode, MarkdownRenderContext } from "@amira/api"
import { MarkdownRendererRegistry } from "../src/render-registry.ts"

const node: MarkdownNode = { type: "math", display: true, source: "x^2" }
const context: MarkdownRenderContext = { width: 20, images: false, maxImageRows: 0, theme: { dark: true } }

test("no-graphics image alternatives retain provenance without changing the result shape", async () => {
  for (const async of [false, true]) {
    for (const text of [{ alt: "x squared" }, { fallback: [{ kind: "text" as const, text: "x squared" }] }]) {
      const registry = new MarkdownRendererRegistry()
      registry.register({
        id: "image",
        match: { math: "display" },
        render: () => {
          const result = { image: { url: "math.png" }, ...text }
          return async ? Promise.resolve(result) : result
        },
      })
      const result = await registry.render(node, context)
      expect(result).toEqual({ lines: [{ kind: "text", text: "x squared" }] })
      expect(registry.isImageAlternative(result!)).toBe(true)
    }
  }
})

test("ordinary text results are not image alternatives", async () => {
  const registry = new MarkdownRendererRegistry()
  registry.register({
    id: "lines",
    match: { math: "display" },
    render: () => ({ lines: [{ kind: "text", text: "x squared" }] }),
  })
  const result = await registry.render(node, context)
  expect(registry.isImageAlternative(result!)).toBe(false)
})
