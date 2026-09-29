import type { MarkdownNode, MarkdownRenderContext, MarkdownRenderResult, ViewLine } from "@amira/api"
import {
  type ImageOpener,
  type ImageStore,
  type MarkdownNodeRef,
  type MarkdownNodes,
  type PendingResult,
  pendingBlock,
  pendingImage,
  stripAnsi,
  type Theme,
  truncateToWidth,
} from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"

/** Where replies' nodes get rendered by extensions (D88): the host's MarkdownRendererRegistry. */
export interface MarkdownRenderSource {
  /** Bumped when renderers come or go. */
  readonly version: number
  readonly claimsImages: boolean
  claimsCode(lang: string): boolean
  waitMs(node: MarkdownNode): number
  render(
    node: MarkdownNode,
    ctx: MarkdownRenderContext,
  ): MarkdownRenderResult | undefined | Promise<MarkdownRenderResult | undefined>
}

/** Where images get drawable (D88): the host's ImageProviderRegistry. */
export interface ImageSource {
  /** Providers installed; none means images are their alt text. */
  readonly size: number
  open: ImageOpener
}

/** A node's rendering: on its way, or done (undefined: no renderer took it). */
export interface Rendering {
  readonly done: boolean
  readonly result: MarkdownRenderResult | undefined
  readonly promise: Promise<MarkdownRenderResult | undefined>
  /** How long the inline transcript waits for it. */
  readonly waitMs: number
  /** Calls `fn` once when it is done; never when it is already. */
  onDone(fn: () => void): void
}

class Entry implements Rendering {
  done = false
  result: MarkdownRenderResult | undefined
  promise: Promise<MarkdownRenderResult | undefined>
  private listeners = new Set<() => void>()

  constructor(
    out: MarkdownRenderResult | undefined | Promise<MarkdownRenderResult | undefined>,
    readonly waitMs: number,
  ) {
    if (out && typeof (out as Promise<unknown>).then === "function") {
      this.promise = (out as Promise<MarkdownRenderResult | undefined>).then(
        (r) => this.settle(r),
        () => this.settle(undefined),
      )
    } else {
      this.done = true
      this.result = out as MarkdownRenderResult | undefined
      this.promise = Promise.resolve(this.result)
    }
  }

  private settle(r: MarkdownRenderResult | undefined) {
    this.done = true
    this.result = r
    const fns = [...this.listeners]
    this.listeners.clear()
    for (const fn of fns) fn()
    return r
  }

  onDone(fn: () => void): void {
    if (!this.done) this.listeners.add(fn)
  }
}

/** Renderings kept, least recently used dropped first. */
const KEPT = 256

/**
 * The renderings of replies' nodes by extensions, for every view of the UI: each node is
 * rendered once per text, width and whether images are drawn, and the result kept, so a frame
 * that asks again (a stream drawn afresh, a resize back) costs nothing.
 */
export class ReplyRenderers {
  private cache = new Map<string, Entry>()
  private version = -1

  constructor(readonly source: MarkdownRenderSource | undefined) {}

  /** Changes whenever what nodes render as may have: a renderer came or went. */
  get generation(): number {
    return this.source?.version ?? 0
  }

  claimsCode(lang: string): boolean {
    return !!this.source?.claimsCode(lang)
  }

  get claimsImages(): boolean {
    return !!this.source?.claimsImages
  }

  /** The node's rendering at `ctx`, started now or kept from before. */
  get(node: MarkdownNode, ctx: MarkdownRenderContext): Rendering {
    const source = this.source
    if (!source) return new Entry(undefined, 0)
    if (source.version !== this.version) {
      this.cache.clear()
      this.version = source.version
    }
    const what =
      node.type === "image" ? `i\0${node.url}\0${node.alt}` : `c\0${node.lang}\0${node.info}\0${node.code}`
    const key = `${ctx.width}\0${ctx.images ? 1 : 0}\0${ctx.maxImageRows}\0${what}`
    const hit = this.cache.get(key)
    if (hit) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit
    }
    const entry = new Entry(source.render(node, ctx), source.waitMs(node))
    this.cache.set(key, entry)
    for (const k of this.cache.keys()) {
      if (this.cache.size <= KEPT) break
      this.cache.delete(k)
    }
    return entry
  }
}

/** A rendered node's lines as rows of `width`: plain text as it is, other kinds in the theme's colors. */
export function nodeRows(lines: ViewLine[], theme: Theme, width: number): string[] {
  return lines.map((l) => {
    const text = truncateToWidth(stripAnsi(l.text).replace(/\s+$/, ""), Math.max(1, width), glyphs.more)
    switch (l.kind) {
      case "muted":
      case "diff-context":
      case "diff-hunk":
        return theme.muted(text)
      case "accent":
        return theme.accent(text)
      case "success":
      case "diff-add":
        return theme.success(text)
      case "warning":
        return theme.warning(text)
      case "error":
      case "diff-remove":
        return theme.error(text)
      default:
        return text
    }
  })
}

/** The node as the registry takes it. */
export function apiNode(node: MarkdownNodeRef): MarkdownNode {
  return node.type === "image"
    ? { type: "image", url: node.url, alt: node.alt }
    : { type: "code", lang: node.lang, info: node.info, code: node.code }
}

export interface InlineNodesOptions {
  renders: ReplyRenderers
  /** Where images are drawn from now, when the terminal draws them and a provider is installed. */
  images: () => ImageStore | undefined
  theme: Theme
  /** How long a committed image may take to load before its alt text goes instead. Default 3 s. */
  imageWaitMs?: number
}

/**
 * The nodes of the inline transcript's stream: images and the code blocks extensions render.
 * A node that is ready when its line is committed goes as it is (an extension's lines, or an
 * image marker the renderer turns into the image once encoded); one still on its way is
 * committed as a marker that becomes it, what follows waiting for it up to its renderer's
 * time, after which the node goes as Markdown renders it. Live, it shows as Markdown.
 */
export function inlineNodes(opts: InlineNodesOptions): MarkdownNodes {
  const { renders, theme } = opts
  return {
    images: true,
    claimsCode: (lang) => renders.claimsCode(lang),
    render(node, rows, col, width, commit) {
      const room = Math.max(1, width - col)
      const store = opts.images()
      const indent = " ".repeat(col)
      const bare = () => rows.map((r) => (r.startsWith(indent) ? r.slice(col) : r))
      const image = (input: { url: string } | { data: Uint8Array }) => {
        if (!store) return rows
        // Asked for while it is live too, so it is often ready by the time it is committed.
        const load = store.inline(input, room)
        return commit ? [indent + pendingImage(load, bare(), opts.imageWaitMs ?? 3000)] : rows
      }
      if (node.type === "image" && !renders.claimsImages) return image({ url: node.url })
      const r = renders.get(apiNode(node), {
        width: room,
        images: !!store,
        maxImageRows: store?.maxRows() ?? 0,
      })
      if (r.done) {
        const out = r.result
        if (!out) return node.type === "image" ? image({ url: node.url }) : rows
        if ("lines" in out) return nodeRows(out.lines, theme, room).map((row) => indent + row)
        return image(out.image)
      }
      if (!commit) return rows
      const load = r.promise.then((out): PendingResult | undefined | Promise<PendingResult | undefined> => {
        if (!out) return node.type === "image" && store ? store.inline({ url: node.url }, room) : undefined
        if ("lines" in out) return nodeRows(out.lines, theme, room)
        return store?.inline(out.image, room)
      })
      return [indent + pendingBlock(load, bare(), r.waitMs)]
    },
  }
}
