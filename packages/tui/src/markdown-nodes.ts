import type { MarkdownNode, MarkdownRenderContext, MarkdownRenderResult } from "@amira/api"
import {
  type ImageOpener,
  type MarkdownNodeRef,
  stripAnsi,
  type Theme,
  truncateToWidth,
} from "@amira/tui-kit"
import { renderToolLines, type ToolLayoutLine } from "./diff-view.ts"
import { viewEllipsis } from "./glyphs.ts"

/** Where replies' nodes get rendered by extensions (D88): the host's MarkdownRendererRegistry. */
export interface MarkdownRenderSource {
  /** Bumped when renderers come or go. */
  readonly version: number
  readonly claimsImages: boolean
  claimsCode(lang: string): boolean
  claimsMath(display: boolean): boolean
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
  /** Calls `fn` once when it is done; never when it is already. */
  onDone(fn: () => void): void
}

class Entry implements Rendering {
  done = false
  result: MarkdownRenderResult | undefined
  private listeners = new Set<() => void>()

  constructor(out: MarkdownRenderResult | undefined | Promise<MarkdownRenderResult | undefined>) {
    if (out && typeof (out as Promise<unknown>).then === "function") {
      void (out as Promise<MarkdownRenderResult | undefined>).then(
        (r) => this.settle(r),
        () => this.settle(undefined),
      )
    } else {
      this.done = true
      this.result = out as MarkdownRenderResult | undefined
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

  theme: MarkdownRenderContext["theme"]
  private themeVersion = 0

  constructor(
    readonly source: MarkdownRenderSource | undefined,
    background: "dark" | "light" = "dark",
  ) {
    this.theme = { dark: background !== "light" }
  }

  /** Rebuild extension renderings on every palette change, even within the same variant. */
  setTheme(background: "dark" | "light"): void {
    this.theme = { dark: background !== "light" }
    this.themeVersion++
    this.cache.clear()
  }

  /** Changes whenever what nodes render as may have: a renderer came or went. */
  get generation(): number {
    return (this.source?.version ?? 0) + this.themeVersion
  }

  claimsCode(lang: string): boolean {
    return !!this.source?.claimsCode(lang)
  }

  get claimsImages(): boolean {
    return !!this.source?.claimsImages
  }

  claimsMath(display: boolean): boolean {
    return !!this.source?.claimsMath(display)
  }

  /** The node's rendering at `ctx`, started now or kept from before. */
  get(node: MarkdownNode, ctx: MarkdownRenderContext): Rendering {
    const source = this.source
    if (!source) return new Entry(undefined)
    if (source.version !== this.version) {
      this.cache.clear()
      this.version = source.version
    }
    const key = JSON.stringify([ctx, node])
    const hit = this.cache.get(key)
    if (hit) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit
    }
    const entry = new Entry(source.render(node, ctx))
    this.cache.set(key, entry)
    for (const k of this.cache.keys()) {
      if (this.cache.size <= KEPT) break
      this.cache.delete(k)
    }
    return entry
  }
}

/** A rendered node's lines as rows of `width`: plain text as it is, other kinds in the theme's colors. */
export function nodeRows(lines: ToolLayoutLine[], theme: Theme, width: number, segments = false): string[] {
  return lines.flatMap((l) => {
    if (!segments && (l.wrap || l.marker || l.description !== undefined || l.continuationMarker))
      return renderToolLines([l], theme, width)
    const text = segments
      ? stripAnsi(l.text)
      : truncateToWidth(stripAnsi(l.text).replace(/\s+$/, ""), Math.max(1, width), viewEllipsis())
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
  return { ...node }
}

/** Text retained with a rendered image, for every text-only view and failed image load. */
export function imageFallback(
  out: Extract<MarkdownRenderResult, { image: unknown }>,
  rows: string[],
  theme: Theme,
  width: number,
): string[] {
  if (out.fallback) return nodeRows(out.fallback, theme, width)
  if (out.alt !== undefined) return nodeRows([{ kind: "text", text: out.alt }], theme, width)
  return rows
}
