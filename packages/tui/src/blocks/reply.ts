import {
  defaultGlyphs,
  type Glyphs,
  type ImageInput,
  type MarkdownNodes,
  MarkdownStream,
  type MarkdownStreamOptions,
  type RenderContext,
  renderMarkdown,
  type ScreenImage,
  stripAnsi,
  type Theme,
  visibleWidth,
} from "@amira/tui-kit"
import { expandTabs } from "../diff-view.ts"
import { replyRows, stampRows, timestampIn, timestampRoom } from "../format.ts"
import { glyphs } from "../glyphs.ts"
import { apiNode, imageFallback, nodeRows, type ReplyRenderers } from "../markdown-nodes.ts"
import { ReplyAlternatives } from "../reply-alternatives.ts"
import { type CopyRow, sliceCells } from "../text-selection.ts"
import {
  Block,
  type BlockEnv,
  type BlockImages,
  type BlockRenders,
  type ImageRow,
  imagesIn,
  MARK,
  mark,
  setImagesIn,
} from "./base.ts"

/** Code blocks longer than this are cut when their reply is folded. */
export const FOLD_CODE_LINES = 12
/** Lines a folded code block keeps. */
const FOLDED_CODE_KEEP = 6

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const DETAILS_OPEN = /^\s*<details(\s[^>]*)?>\s*$/i
const DETAILS_CLOSE = /^\s*<\/details>\s*$/i
const SUMMARY = /^\s*<summary>(.*?)<\/summary>\s*$/i

/**
 * A reply's Markdown as the full-screen transcript shows it. `<details>` sections read as
 * "▾ summary" and their body, or folded as "▸ summary" alone; folded, a code block longer than
 * FOLD_CODE_LINES keeps its first lines and says how many more there are. `foldable` says
 * whether folding would change anything.
 */
export function foldMarkdown(source: string, folded: boolean): { text: string; foldable: boolean } {
  const out: string[] = []
  let foldable = false
  let fence: { mark: string; start: number } | undefined
  let details: { depth: number; start: number; summary?: string } | undefined
  const lines = source.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (fence) {
      const close = FENCE.exec(line)
      if (
        close &&
        close[1]![0] === fence.mark[0] &&
        close[1]!.length >= fence.mark.length &&
        !line.trim().slice(close[1]!.length).trim()
      ) {
        const body = out.length - fence.start
        if (body > FOLD_CODE_LINES) {
          foldable = true
          if (folded)
            out.splice(
              fence.start + FOLDED_CODE_KEEP,
              body - FOLDED_CODE_KEEP,
              `${glyphs.more} ${body - FOLDED_CODE_KEEP} more lines`,
            )
        }
        fence = undefined
      }
      if (!details || !folded) out.push(line)
      continue
    }
    const open = FENCE.exec(line)
    if (open) {
      if (!details || !folded) {
        out.push(line)
        fence = { mark: open[1]!, start: out.length }
      } else fence = { mark: open[1]!, start: out.length }
      continue
    }
    if (DETAILS_OPEN.test(line)) {
      foldable = true
      if (details) details.depth++
      else details = { depth: 1, start: out.length }
      continue
    }
    if (details && DETAILS_CLOSE.test(line)) {
      if (--details.depth === 0) {
        const title = `**${folded ? "▸" : "▾"} ${details.summary ?? "Details"}**`
        out.splice(details.start, 0, title, "")
        details = undefined
      }
      continue
    }
    const summary =
      details && details.depth === 1 && details.summary === undefined ? SUMMARY.exec(line) : null
    if (summary && details) {
      details.summary = summary[1]!.trim()
      continue
    }
    if (!details || !folded) out.push(line)
  }
  if (details) out.splice(details.start, 0, `**${folded ? "▸" : "▾"} ${details.summary ?? "Details"}**`, "")
  return { text: out.join("\n"), foldable }
}

/**
 * The assistant's reply: its Markdown source, rendered per width. While it streams, a
 * MarkdownStream renders only what arrived since the last frame; a width change starts it
 * over from the source.
 */
export class ReplyBlock extends Block {
  readonly kind = "assistant"
  source = ""
  folded = false
  private stream: MarkdownStream | undefined
  private streamWidth = 0
  private streamTheme: Theme | undefined
  private streamGlyphs: BlockEnv["glyphs"]
  /** The images the stream was made to draw with, if any. */
  private streamImages: BlockImages | undefined
  private streamImageRows = 0
  /** Images laid out by their marks' ids, with their alt text. */
  private marks = new Map<number, { image: ScreenImage; alt: string; fallback?: string[] }>()
  #hasImages = false
  #streaming: boolean
  private lastImages: BlockImages | undefined
  private lastRenders: BlockRenders | undefined
  /** The Markdown chrome and reply prefix used by the last rendering, for copying its rows. */
  private lastGlyphs: Glyphs = defaultGlyphs
  private lastAssistant = glyphs.assistant
  private alternatives = new ReplyAlternatives()
  /** What the stream was made with from the renderers: their generation, or -1 without them. */
  private streamRenders = -1
  /** An image file came in (or failed): its rows change. */
  private readonly imageLoaded = () => {
    this.stream = undefined
    this.touch()
    this.lastImages?.changed()
  }
  /** A node an extension renders came in (or failed): its rows change. */
  private readonly rendered = () => {
    this.stream = undefined
    this.touch()
    this.lastRenders?.changed()
  }

  constructor(
    source: string,
    streaming: boolean,
    private hyperlinks: boolean,
    readonly timestamp?: number,
  ) {
    super()
    this.source = source
    this.#streaming = streaming
  }

  get streaming(): boolean {
    return this.#streaming
  }

  override get live(): boolean {
    return this.#streaming
  }

  append(text: string): void {
    this.source += text
    this.stream?.append(text)
  }

  /** The reply is complete; from now on it is drawn from its source. */
  finish(): void {
    this.#streaming = false
    this.stream = undefined
    this.touch()
  }

  lines(env: BlockEnv): string[] {
    this.lastGlyphs = env.glyphs ?? defaultGlyphs
    this.lastAssistant = glyphs.assistant
    const width = Math.max(1, env.width - visibleWidth(glyphs.assistant))
    const firstRowWidth = Math.max(
      1,
      timestampRoom(env.width, this.timestamp) - visibleWidth(glyphs.assistant),
    )
    // Folded, images are their alt text.
    const images = this.folded ? undefined : env.images
    // Folded, its code is cut short: extensions do not render it.
    const renders = this.folded ? undefined : env.renders
    this.lastImages = images
    this.lastRenders = renders
    const opts: MarkdownStreamOptions = { hyperlinks: this.hyperlinks, glyphs: env.glyphs, firstRowWidth }
    if (images || renders?.renders.source) opts.nodes = this.nodes(env.theme, images, renders?.renders)
    const imageRows = images ? images.store.maxRows() : 0
    const generation = renders ? renders.renders.generation : -1
    let rows: string[]
    if (this.#streaming && !this.folded) {
      if (
        !this.stream ||
        this.streamWidth !== width ||
        this.streamTheme !== env.theme ||
        this.streamGlyphs !== env.glyphs ||
        this.streamImages !== images ||
        this.streamImageRows !== imageRows ||
        this.streamRenders !== generation
      ) {
        // Images are laid out afresh with it: only those of its rows are kept.
        this.marks.clear()
        this.stream = new MarkdownStream(opts)
        this.stream.append(this.source)
        this.streamWidth = width
        this.streamTheme = env.theme
        this.streamGlyphs = env.glyphs
        this.streamImages = images
        this.streamImageRows = imageRows
        this.streamRenders = generation
      }
      const ctx: RenderContext = {
        theme: env.theme,
        glyphs: env.glyphs,
        color: true,
        rows: Number.POSITIVE_INFINITY,
      }
      rows = this.stream.render(width, ctx)
      while (rows.length && rows[rows.length - 1]!.trim() === "") rows = rows.slice(0, -1)
    } else {
      // Its marks are laid out afresh: a stream made before (folded while streaming) starts over.
      this.stream = undefined
      this.marks.clear()
      const { text } = foldMarkdown(this.source, this.folded)
      rows = renderMarkdown(text, width, env.theme, opts)
    }
    const lines = this.layOut(replyRows(rows), images !== undefined)
    return stampRows(lines, env.theme, env.width, this.timestamp)
  }

  /**
   * The nodes of its Markdown drawn otherwise: images (with `images`), and what extensions
   * render (with `renders`): their lines, or an image. A rendering still on its way shows as
   * Markdown renders it, and the block is drawn again once it is in.
   */
  private nodes(
    theme: Theme,
    images: BlockImages | undefined,
    renders: ReplyRenderers | undefined,
    textOnly = false,
  ): MarkdownNodes {
    return {
      images: true,
      claimsCode: (lang) => !!renders?.claimsCode(lang) || (textOnly && this.alternatives.claimsCode(lang)),
      claimsMath: (display) =>
        !!renders?.claimsMath(display) || (textOnly && this.alternatives.claimsMath(display)),
      inline: (node, fallback, width) => {
        if (!renders) return fallback
        const r = renders.get(apiNode(node), {
          width,
          images: false,
          maxImageRows: 0,
          theme: renders.theme,
        })
        if (!r.done) r.onDone(this.rendered)
        return r.result && "segments" in r.result
          ? nodeRows(r.result.segments, theme, width, true).join("")
          : fallback
      },
      render: (node, fallback, col, width) => {
        const room = Math.max(1, width - col)
        const retained = textOnly ? this.alternatives.get(node) : undefined
        if (retained) return nodeRows(retained, theme, room).map((row) => " ".repeat(col) + row)
        if (node.type === "image" && !renders?.claimsImages)
          return images && !textOnly
            ? this.imageRows(images, { url: node.url }, fallback, col, width)
            : fallback
        if (!renders) return fallback
        const r = renders.get(apiNode(node), {
          width: room,
          images: !!images,
          maxImageRows: images?.store.maxRows() ?? 0,
          theme: renders.theme,
        })
        if (!r.done) {
          this.alternatives.watch(node, r, renders.source, this.rendered)
          return fallback
        }
        const out = r.result
        if (!out) {
          if (node.type === "image" && images && !textOnly)
            return this.imageRows(images, { url: node.url }, fallback, col, width)
          return fallback
        }
        this.alternatives.remember(node, out, renders.source)
        if ("lines" in out) return nodeRows(out.lines, theme, room).map((row) => " ".repeat(col) + row)
        if ("segments" in out) return fallback
        const text = imageFallback(
          out,
          fallback.map((row) => row.slice(col)),
          theme,
          room,
        )
        const shown = text.map((row) => " ".repeat(col) + row)
        const raw = this.alternatives.get(node)?.map((line) => stripAnsi(line.text))
        const alt =
          out.alt ??
          raw?.join(" ") ??
          (node.type === "code" ? `${defaultGlyphs.image} ${node.lang || "diagram"}`.trim() : undefined)
        return images && !textOnly ? this.imageRows(images, out.image, shown, col, width, alt, raw) : shown
      },
    }
  }

  /** The rows an image takes: its marks, once its size is known; its alt text until then. */
  private imageRows(
    images: BlockImages,
    input: ImageInput,
    fallback: string[],
    col: number,
    width: number,
    altText?: string,
    text?: string[],
  ): string[] {
    const source = images.store.screen(input)
    if (source.state === "loading") source.onSettled(this.imageLoaded)
    const image = source.image(Math.max(1, width - col), images.store.maxRows())
    if (!image || image.broken) return fallback
    const indent = " ".repeat(col)
    const first = fallback[0] ?? ""
    const alt = altText ?? (first.startsWith(indent) ? first.slice(col) : first)
    this.marks.set(image.id, { image, alt, ...(text ? { fallback: text } : {}) })
    return Array.from({ length: image.rows }, (_, k) => indent + mark(image.id, k))
  }

  /** Blanks the rows of images, noting where each starts. */
  private layOut(lines: string[], drawing: boolean): string[] {
    if (!drawing) return lines
    const found: ImageRow[] = []
    for (let i = 0; i < lines.length; i++) {
      const m = MARK.exec(
        lines[i]!.startsWith(glyphs.assistant) ? lines[i]!.slice(glyphs.assistant.length) : lines[i]!,
      )
      if (!m) continue
      lines[i] = ""
      const at = this.marks.get(Number(m[2]))
      if (at && m[3] === "0")
        found.push({
          line: i,
          col: visibleWidth(glyphs.assistant) + m[1]!.length,
          image: at.image,
          alt: at.alt,
          ...(at.fallback ? { fallback: at.fallback, changed: this.imageLoaded } : {}),
        })
    }
    this.#hasImages = found.length > 0
    if (found.length) setImagesIn(lines, found)
    return lines
  }

  copyText(): string {
    return this.alternatives.copy(this.source).trim()
  }

  /**
   * Its rows copy without the reply's indent. Code blocks copy as their code: the frame rows
   * are left out, the side before each row too, and a line of code wrapped over rows is one
   * line again (matched against the source; if they do not match, its rows stay lines). An
   * image copies as its alt text, once.
   */
  override copyRows(plain: readonly string[], lines: readonly string[]): CopyRow[] {
    const indent = visibleWidth(this.lastAssistant)
    const rows: CopyRow[] = plain.map(() => ({ from: indent }))
    // A quote's bars are chrome too; both glyphs may contain regexp punctuation.
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const bars = new RegExp(`^${escapeRe(this.lastAssistant)}((?:${escapeRe(this.lastGlyphs.quoteBar)} ?)+)`)
    for (const [i, p] of plain.entries()) {
      const m = bars.exec(p)
      if (m) rows[i] = { from: indent + visibleWidth(m[1]!) }
    }
    const fences = fencedCode(foldMarkdown(this.source, this.folded).text)
    // Frames are matched to the fences of the source in order; one that matches none (a fence
    // the source is not read for, say in a nested list) copies row by row.
    let next = 0
    for (const f of codeFrames(plain, this.lastGlyphs, this.lastAssistant)) {
      rows[f.top] = { from: 0, skip: true }
      if (f.bottom !== undefined) rows[f.bottom] = { from: 0, skip: true }
      const shown = f.rows.map((r) => plain[r]!.slice(f.textCol ?? f.col))
      let at: number[] | undefined
      for (let q = next; q < fences.length && !at; q++) {
        at = linesOf(shown, fences[q]!.shown)
        if (at) next = q + 1
      }
      const fence = at && fences[next - 1]!
      for (const [k, r] of f.rows.entries()) {
        const line = at?.[k]
        if (line === undefined) rows[r] = { from: f.col }
        else if (k > 0 && at![k - 1] === line) rows[r] = { from: f.col, joins: true }
        else rows[r] = { from: f.col, exact: fence!.exact[line]! }
      }
    }
    for (const im of imagesIn(lines) ?? []) {
      const text = stripAnsi(im.fallback?.join("\n") ?? im.alt).trim()
      for (let k = 0; k < im.image.rows && im.line + k < rows.length; k++)
        rows[im.line + k] = k ? { from: 0, text, repeats: true } : { from: 0, text }
    }
    const stamp = timestampIn(lines)
    if (stamp && plain[0] !== undefined) {
      const first = rows[0]!
      first.to = stamp.to
      if (!first.skip && first.text === undefined && first.exact === undefined)
        first.exact = sliceCells(plain[0], first.from, stamp.to)
    }
    return rows
  }

  override foldable(): boolean {
    // Folded, its images are their alt text.
    return this.#hasImages || foldMarkdown(this.source, false).foldable
  }

  override toggleFold(): void {
    this.folded = !this.folded
    this.touch()
  }

  override isFolded(): boolean {
    return this.folded
  }

  override get refolded(): boolean {
    return this.folded
  }

  override printLines(env: BlockEnv): string[] {
    const width = Math.max(1, env.width - visibleWidth(glyphs.assistant))
    const firstRowWidth = Math.max(
      1,
      timestampRoom(env.width, this.timestamp) - visibleWidth(glyphs.assistant),
    )
    const { text } = foldMarkdown(this.source, false)
    const lines = replyRows(
      renderMarkdown(text, width, env.theme, {
        hyperlinks: this.hyperlinks,
        glyphs: env.glyphs,
        nodes: this.nodes(env.theme, undefined, env.renders?.renders, true),
        firstRowWidth,
      }),
    )
    return stampRows(lines, env.theme, env.width, this.timestamp)
  }
}

/** A code block's frame in a reply's rows: its top and bottom rows, its code rows, and the column its code starts at. */
export interface CodeFrame {
  top: number
  bottom?: number
  rows: number[]
  /** Display cells before the code, for selection and copying. */
  col: number
  /** Character offset before the code, only when it differs from the display column. */
  textCol?: number
}

/** The frames of code blocks in rows of rendered Markdown (without styles). */
export function codeFrames(
  plain: readonly string[],
  markdownGlyphs: Glyphs = defaultGlyphs,
  assistant = "",
): CodeFrame[] {
  const { codeTop, codeSide, codeBottom } = markdownGlyphs
  const out: CodeFrame[] = []
  for (let i = 0; i < plain.length; i++) {
    const row = plain[i]!
    const lead = assistant && row.startsWith(assistant) ? assistant.length : 0
    const at = lead + /^ */.exec(row.slice(lead))![0].length
    if (!row.startsWith(codeTop, at)) continue
    const pad = row.slice(0, at)
    const col = visibleWidth(pad) + visibleWidth(codeSide) + 1
    const textCol = at + codeSide.length + 1
    const frame: CodeFrame = { top: i, rows: [], col, ...(textCol !== col ? { textCol } : {}) }
    out.push(frame)
    while (i + 1 < plain.length) {
      const row = plain[i + 1]!
      if (row.startsWith(pad + codeBottom)) {
        frame.bottom = ++i
        break
      }
      if (!row.startsWith(pad + codeSide)) break
      frame.rows.push(++i)
    }
  }
  return out
}

/** A fence at any indent: the source is read for more fences than there are, not fewer. */
const ANY_FENCE = /^ *(`{3,}|~{3,})/

/** A fenced code block of Markdown: its lines as drawn (tabs as spaces) and as written. */
interface Fence {
  shown: string[]
  exact: string[]
}

/** The fenced code blocks of Markdown, in order (the last one maybe still open). */
function fencedCode(markdown: string): Fence[] {
  const out: Fence[] = []
  let open: { mark: string; indent: number; fence: Fence } | undefined
  for (const line of markdown.split("\n")) {
    if (open) {
      const close = ANY_FENCE.exec(line)
      if (
        close &&
        close[1]![0] === open.mark[0] &&
        close[1]!.length >= open.mark.length &&
        !line.trim().slice(close[1]!.length).trim()
      ) {
        open = undefined
        continue
      }
      // The fence's indent goes, as much of it as the line has.
      const cut = (s: string) => {
        let start = 0
        while (start < open!.indent && s[start] === " ") start++
        return s.slice(start)
      }
      open.fence.shown.push(cut(expandTabs(line)))
      open.fence.exact.push(cut(line))
      continue
    }
    const start = ANY_FENCE.exec(line)
    if (start) {
      open = { mark: start[1]!, indent: /^ */.exec(line)![0].length, fence: { shown: [], exact: [] } }
      out.push(open.fence)
    }
  }
  return out
}

/**
 * The line of a code block's source each of its rows shows (a line wrapped over rows is shown
 * by several), found by matching the rows to the lines. Undefined when they do not match.
 */
function linesOf(rows: string[], source: string[]): number[] | undefined {
  const out: number[] = []
  let r = 0
  for (const [i, line] of source.entries()) {
    if (r >= rows.length) break
    let text = rows[r++]!
    out.push(i)
    while (r < rows.length && text.length < line.length && rows[r] && line.startsWith(text + rows[r])) {
      text += rows[r++]
      out.push(i)
    }
    if (text.trimEnd() !== line.trimEnd()) return undefined
  }
  return r === rows.length ? out : undefined
}
