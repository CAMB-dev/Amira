import type { MarkdownNode } from "@amira/api"
import type { MarkdownRendererRegistry } from "@amira/core"
import { mathCodeLine, mathSources } from "@amira/tui-kit/math-source"

interface Fence {
  marker: string
  info: string
  source: string
  body: string[]
}

interface Display {
  source: string
}

const newline = (text: string) => (text.endsWith("\r\n") ? "\r\n" : text.endsWith("\n") ? "\n" : "")

/**
 * A source-preserving print stream, not a terminal Markdown formatter. Only completed nodes
 * claimed by extensions are replaced; everything around them keeps its original bytes.
 * The caller serializes writes and boundaries so asynchronous renderers cannot reorder output.
 */
export class PrintMarkdown {
  private tail = ""
  private paragraph = ""
  private fence: Fence | undefined
  private display: Display | undefined
  private codeThrough = 0

  constructor(
    private readonly registry: MarkdownRendererRegistry,
    private readonly stdout: (text: string) => void,
  ) {}

  async write(text: string): Promise<void> {
    this.tail += text
    await this.drain(false)
  }

  private async drain(final: boolean): Promise<void> {
    while (this.tail) {
      const end = this.tail.indexOf("\n")
      if (end === -1 && !final) break
      const raw = end === -1 ? this.tail : this.tail.slice(0, end + 1)
      const inCode = this.codeThrough > 0
      const fence = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)/)
      const block =
        /^ {0,3}(\$\$(?!\$)|\\\[)/.test(raw) || (fence && !(fence[1]![0] === "`" && fence[2]!.includes("`")))
      if (
        (this.registry.claimsMath(false) || this.registry.claimsMath(true)) &&
        !this.fence &&
        !this.display &&
        (inCode || !block)
      ) {
        const code = mathCodeLine(this.tail, this.codeThrough, final)
        if (!code) break
        this.codeThrough = code.through
      }
      this.tail = this.tail.slice(raw.length)
      this.codeThrough = Math.max(0, this.codeThrough - raw.length)
      await this.line(raw, inCode)
    }
  }

  /** A message/tool boundary completes paragraphs, but never invents a closing delimiter. */
  async finish(): Promise<void> {
    await this.drain(true)
    this.tail = ""
    await this.flushParagraph()
    if (this.fence) this.stdout(this.fence.source)
    if (this.display) this.stdout(this.display.source)
    this.fence = undefined
    this.display = undefined
    this.codeThrough = 0
  }

  private async line(raw: string, inCode = false): Promise<void> {
    const ending = newline(raw)
    const text = raw.slice(0, raw.length - ending.length)
    if (this.fence) {
      const fence = this.fence
      fence.source += raw
      const close = text.match(/^ {0,3}(`+|~+)[ \t]*$/)?.[1]
      if (close && close[0] === fence.marker[0] && close.length >= fence.marker.length) {
        this.fence = undefined
        const lang = fence.info.split(/\s/)[0] ?? ""
        const node: MarkdownNode = { type: "code", lang, info: fence.info, code: fence.body.join("\n") }
        this.stdout(
          this.registry.claimsCode(lang) ? await this.render(node, fence.source, ending) : fence.source,
        )
      } else fence.body.push(text)
      return
    }
    if (this.display) {
      const display = this.display
      display.source += raw
      const math = /(?:\$\$|\\\])[ \t]*$/.test(text) ? mathSources(display.source)[0] : undefined
      if (math) {
        this.display = undefined
        this.stdout(
          await this.render({ type: "math", display: true, source: math.source }, display.source, ending),
        )
      }
      return
    }
    if (inCode) {
      this.paragraph += raw
      return
    }
    const fence = text.match(/^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/)
    if (fence && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) {
      await this.flushParagraph()
      this.fence = { marker: fence[1]!, info: fence[2]!.trim(), source: raw, body: [] }
      return
    }
    const trimmed = text.trim()
    if (/^ {0,3}(\$\$(?!\$)|\\\[)/.test(text)) {
      await this.flushParagraph()
      const math = mathSources(raw)[0]
      if (math) {
        this.stdout(await this.render({ type: "math", display: true, source: math.source }, raw, ending))
      } else this.display = { source: raw }
      return
    }
    const image = standaloneImage(text)
    if (image) {
      await this.flushParagraph()
      this.stdout(this.registry.claimsImages ? await this.render(image, raw, ending) : raw)
      return
    }
    if (!trimmed) {
      await this.flushParagraph()
      this.stdout(raw)
    } else if (this.registry.claimsMath(false) || this.registry.claimsMath(true) || this.codeThrough > 0) {
      this.paragraph += raw
    } else this.stdout(raw)
  }

  private async flushParagraph(): Promise<void> {
    const text = this.paragraph
    this.paragraph = ""
    let start = 0
    for (const math of mathSources(text)) {
      if (math.display) continue
      this.stdout(text.slice(start, math.start))
      this.stdout(
        await this.render(
          { type: "math", display: false, source: math.source },
          text.slice(math.start, math.end),
          "",
        ),
      )
      start = math.end
    }
    this.stdout(text.slice(start))
  }

  private async render(node: MarkdownNode, source: string, ending: string): Promise<string> {
    if (node.type === "math" && !this.registry.claimsMath(node.display)) return source
    const result = await this.registry.render(node, {
      width: process.stdout.columns || 80,
      images: false,
      maxImageRows: 0,
      // Print mode never probes a terminal: dark is its stable, non-TTY theme default.
      theme: { dark: true },
    })
    if (!result) return source
    if ("segments" in result) return result.segments.map((segment) => segment.text).join("")
    if ("lines" in result) return result.lines.map((line) => line.text).join("\n") + ending
    // The registry converts image fallbacks to text with images:false. Never emit graphics.
    return source
  }
}

/** A standalone inline image, optionally wrapped in a link; other Markdown stays untouched. */
function standaloneImage(text: string): Extract<MarkdownNode, { type: "image" }> | undefined {
  const linked = text.match(/^ {0,3}\[(!\[.*\]\(.*\))\]\([^)]*\)[ \t]*$/)
  const match = (linked?.[1] ?? text).match(
    /^ {0,3}!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>]*>|(?:\\.|[^\s()\\]|\([^()\s]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)[ \t]*$/,
  )
  if (!match) return undefined
  const url = match[2]!.replace(/^<|>$/g, "").replace(/\\([\\()[\]])/g, "$1")
  return { type: "image", alt: match[1]!.replace(/\\([\\[\]])/g, "$1"), url }
}
