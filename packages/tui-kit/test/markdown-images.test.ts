// B deliberate oracle: claimed-code fallbacks are filled surfaces, with language at top right.
import { expect, test } from "bun:test"
import { stripAnsi } from "../src/ansi.ts"
import type { RenderContext } from "../src/component.ts"
import { type MarkdownNodes, MarkdownStream } from "../src/components/markdown-stream.ts"
import { findImageMarker, imageState, pendingBlock } from "../src/images/placement.ts"
import type { ImageBlock } from "../src/images/types.ts"
import { plain } from "./context.ts"

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
  expect(m.render(30, ctx)).toEqual(["Look:", "🖼\uFE0F a cat (cat.png)"])
  expect(loads).toEqual([["cat.png", 30]])
  m.append("\n\nafter")
  m.render(30, ctx)
  expect(committed.length).toBe(2)
  expect(committed[0]).toBe("Look:")
  const marker = findImageMarker(committed[1]!)!
  expect(marker.prefix).toBe("")
  expect(imageState(marker.id)).toMatchObject({ kind: "wait", fallback: ["🖼\uFE0F a cat (cat.png)"] })
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
  expect(rows("see ![x](a.png)")).toEqual(["see 🖼\uFE0F x (a.png)"])
  expect(rows("![x](a.png) ![y](b.png)")).toEqual(["🖼\uFE0F x (a.png) 🖼\uFE0F y (b.png)"])
  // A reference not defined has no target to load.
  expect(rows("![x][nope]")).toEqual(["🖼\uFE0F x"])
  expect(findImageMarker(rows("[r]: r.png\n\n![x][r]")[0]!)).toBeDefined()
  // Under a list item, at the item's text.
  const item = rows("- item\n\n  ![x](a.png)")
  const m = findImageMarker(item[2]!)!
  expect(m.prefix).toBe("  ")
  expect((imageState(m.id) as { fallback: string[] }).fallback.map(stripAnsi)).toEqual(["🖼\uFE0F x (a.png)"])
  // Without images, never.
  const none = new MarkdownStream({ hyperlinks: false })
  none.append("![x](a.png)")
  expect(none.take(40).map(stripAnsi)).toEqual(["🖼\uFE0F x (a.png)"])
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

/** Nodes rendering ```diagram blocks: `render` says what each becomes, and is recorded. */
function diagrams(render: (code: string, commit: boolean) => string[] | undefined) {
  const calls: { code: string; info: string; fallback: string[]; col: number; commit: boolean }[] = []
  const nodes: MarkdownNodes = {
    claimsCode: (lang) => lang.toLowerCase() === "diagram",
    render(node, fallback, col, _width, commit) {
      if (node.type !== "code") return fallback
      calls.push({ code: node.code, info: node.info, fallback: fallback.map(stripAnsi), col, commit })
      return render(node.code, commit) ?? fallback
    },
  }
  return { nodes, calls }
}

test("a claimed code block is held until it closes, shown live as code, then committed once as its rendering", () => {
  const { nodes, calls } = diagrams((code) => [`[${code.replace("\n", "|")}]`])
  const m = new MarkdownStream({ hyperlinks: false, highlight: false, nodes })
  const { ctx, committed } = committing()
  m.append("Here:\n\n```diagram big\nA --> B\n")
  // Live: the code so far, no bottom yet; nothing of it committed, and nothing asked for yet.
  expect(m.render(30, ctx).map(stripAnsi)).toEqual([
    "",
    `${" ".repeat(23)}diagram`,
    `A --> B${" ".repeat(23)}`,
  ])
  expect(committed).toEqual(["Here:"])
  m.append("B --> C")
  expect(m.render(30, ctx).map(stripAnsi)).toEqual([
    "",
    `${" ".repeat(23)}diagram`,
    `A --> B${" ".repeat(23)}`,
    `B --> C${" ".repeat(23)}`,
  ])
  expect(calls).toEqual([])
  m.append("\n```\nafter")
  m.render(30, ctx)
  expect(committed).toEqual(["Here:", "", "[A --> B|B --> C]"])
  expect(calls).toEqual([
    {
      code: "A --> B\nB --> C",
      info: "diagram big",
      fallback: [
        `${" ".repeat(23)}diagram`,
        `A --> B${" ".repeat(23)}`,
        `B --> C${" ".repeat(23)}`,
        " ".repeat(30),
      ],
      col: 0,
      commit: true,
    },
  ])
  expect(m.take(30)).toEqual(["after"])
  // Other languages stream as always, line by line.
  const plainCode = new MarkdownStream({ hyperlinks: false, highlight: false, nodes })
  const c2 = committing()
  plainCode.append("```js\nx()\n")
  plainCode.render(30, c2.ctx)
  expect(c2.committed.map(stripAnsi)).toEqual([`${" ".repeat(28)}js`, `x()${" ".repeat(27)}`])
})

test("a claimed block never commits in parts: taller than the live region, its end shows live", () => {
  const { nodes } = diagrams(() => ["drawn"])
  const m = new MarkdownStream({ hyperlinks: false, highlight: false, nodes })
  const { ctx, committed } = committing()
  m.maxRows = 3
  m.append(`\`\`\`diagram\n${Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n")}\n`)
  expect(m.render(30, ctx).map(stripAnsi)).toEqual([
    `line 5${" ".repeat(24)}`,
    `line 6${" ".repeat(24)}`,
    `line 7${" ".repeat(24)}`,
  ])
  expect(committed).toEqual([])
  m.append("```\n")
  m.render(30, ctx)
  expect(committed).toEqual(["drawn"])
})

test("a claimed block the text ends inside is rendered too; in a list it keeps its column", () => {
  const { nodes, calls } = diagrams((code) => [`<${code}>`])
  const m = new MarkdownStream({ hyperlinks: false, highlight: false, nodes })
  m.append("- item\n\n  ```diagram\n  A\n  B")
  const rows = m.take(30)
  expect(rows.map(stripAnsi)).toEqual(["• item", "", "<A\nB>"])
  expect(calls[0]).toMatchObject({ code: "A\nB", col: 2, commit: true })
  // Declined (the fallback back): shown as the code block it is.
  const none = diagrams(() => undefined)
  const n = new MarkdownStream({ hyperlinks: false, highlight: false, nodes: none.nodes })
  n.append("```diagram\nA\n```")
  expect(n.take(30).map(stripAnsi)).toEqual([
    `${" ".repeat(23)}diagram`,
    `A${" ".repeat(29)}`,
    " ".repeat(30),
  ])
})

test("pendingBlock resolves failures to fallback and sanitizes rows", async () => {
  const failed = findImageMarker(pendingBlock(Promise.resolve(undefined), ["fb"]))!
  await Bun.sleep(0)
  expect(imageState(failed.id)).toEqual({ kind: "fallback", fallback: ["fb"] })
  // Its rows are made safe to print: only styles stay.
  const rows = findImageMarker(pendingBlock(Promise.resolve(["a\x1b]52;c;eA==\x07b"]), []))!
  await Bun.sleep(0)
  expect(imageState(rows.id)).toEqual({ kind: "rows", rows: ["ab"], fallback: [] })
})
