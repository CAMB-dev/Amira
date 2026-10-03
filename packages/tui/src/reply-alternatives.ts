import type { MarkdownRenderResult, ToolLine } from "@amira/api"
import { type MarkdownNodeRef, renderMarkdown, stripAnsi } from "@amira/tui-kit"
import { mathSources } from "@amira/tui-kit/math-source"
import type { MarkdownRenderSource, Rendering } from "./markdown-nodes.ts"

/** Registries can distinguish image alternatives after reducing an image to text-only lines. */
type AlternativeSource = MarkdownRenderSource & {
  isImageAlternative?(result: MarkdownRenderResult): boolean
}

function key(node: MarkdownNodeRef): string {
  switch (node.type) {
    case "math":
      return JSON.stringify([node.type, node.display, node.source])
    case "code":
      return JSON.stringify([node.type, node.lang, node.info, node.code])
    case "image":
      return JSON.stringify([node.type, node.url, node.alt])
  }
}

/** Resolved text belongs to its reply, not the shared rendering cache or the last viewport. */
export class ReplyAlternatives {
  private entries = new Map<string, { node: MarkdownNodeRef; lines: ToolLine[]; copy: boolean }>()
  private pending = new WeakSet<Rendering>()

  watch(
    node: MarkdownNodeRef,
    rendering: Rendering,
    source: AlternativeSource | undefined,
    done: () => void,
  ): void {
    if (this.pending.has(rendering)) return
    this.pending.add(rendering)
    rendering.onDone(() => {
      if (rendering.result) this.remember(node, rendering.result, source)
      done()
    })
  }

  remember(node: MarkdownNodeRef, result: MarkdownRenderResult, source?: AlternativeSource): void {
    const lines =
      "lines" in result
        ? result.lines
        : "image" in result
          ? (result.fallback ??
            (result.alt !== undefined ? [{ kind: "text" as const, text: result.alt }] : undefined))
          : undefined
    if (!lines) return
    // Custom sources without provenance still retain text results rather than lose image text.
    const copy = "image" in result || (source?.isImageAlternative?.(result) ?? true)
    this.entries.set(key(node), { node, lines, copy })
  }

  get(node: MarkdownNodeRef): ToolLine[] | undefined {
    return this.entries.get(key(node))?.lines
  }

  claimsCode(lang: string): boolean {
    return [...this.entries.values()].some(({ node }) => node.type === "code" && node.lang === lang)
  }

  claimsMath(display: boolean): boolean {
    return [...this.entries.values()].some(({ node }) => node.type === "math" && node.display === display)
  }

  copy(source: string): string {
    if (![...this.entries.values()].some((entry) => entry.copy)) return source
    const ranges = nodeSources(source)
    let text = ""
    let from = 0
    for (const range of ranges) {
      const entry = this.entries.get(key(range.node))
      if (!entry?.copy || range.start < from) continue
      text +=
        source.slice(from, range.start) +
        entry.lines.map((line) => stripAnsi(line.text)).join(`\n${range.indent}`)
      from = range.end
    }
    return text + source.slice(from)
  }
}

interface NodeSource {
  node: MarkdownNodeRef
  start: number
  end: number
  indent: string
}

/** Source ranges only: never serialize the rest of the reply through the display renderer. */
function nodeSources(source: string): NodeSource[] {
  const ranges: NodeSource[] = mathSources(source)
    .filter((math) => math.display)
    .map((math) => {
      const indent = /^ */.exec(source.slice(math.start))![0]
      return {
        node: { type: "math", display: true, source: math.source },
        start: math.start + indent.length,
        end: math.end,
        indent,
      }
    })
  const lines = source.split("\n")
  const refs: string[] = []
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const start = offset
    offset += line.length + 1
    if (ranges.some((range) => start >= range.start - range.indent.length && start < range.end)) continue
    if (/^\s*\[[^\]]+\]:/.test(line)) refs.push(line)
    const fence = /^(\s*(?:>\s*)*(?:(?:[-+*]|\d+[.)])\s+)?)(`{3,}|~{3,})(.*)$/.exec(line)
    let end = start + line.length
    let chunk = line
    let indent = /^\s*/.exec(line)![0]
    if (fence && !(fence[2]![0] === "`" && fence[3]!.includes("`"))) {
      const mark = fence[2]!
      const body = [line]
      while (++i < lines.length) {
        const row = lines[i]!
        body.push(row)
        end = offset + row.length
        offset += row.length + 1
        const close = /^\s*(`+|~+)\s*$/.exec(row)
        if (close && close[1]![0] === mark[0] && close[1]!.length >= mark.length) break
      }
      chunk = body.join("\n")
      indent = fence[1]!
    } else {
      const image = /^(\s*(?:>\s*)*(?:(?:[-+*]|\d+[.)])\s+)?)(?=\[?!\[)/.exec(line)
      if (!image) continue
      indent = image[1]!
    }
    // Reuse the Markdown parser for fence info, image URLs, titles, links and references.
    // This renders just the candidate node, never the surrounding source being copied.
    renderMarkdown([...refs, "", chunk].join("\n"), 80, undefined, {
      nodes: {
        images: true,
        claimsCode: () => true,
        render(node, fallback) {
          if (node.type === "code" || node.type === "image")
            ranges.push({
              node,
              start: start + indent.length,
              end,
              indent: indent.replace(/(?:[-+*]|\d+[.)])\s+$/, (marker) => " ".repeat(marker.length)),
            })
          return fallback
        },
      },
    })
  }
  return ranges.sort((a, b) => a.start - b.start)
}
