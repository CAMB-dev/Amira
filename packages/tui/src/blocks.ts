import type { ToolDetailLevel, ToolRejection, ToolResult, UserMessage } from "@amira/api"
import { toolResultText } from "@amira/api"
import {
  defaultGlyphs,
  type ImageLoader,
  MarkdownStream,
  type MarkdownStreamOptions,
  type RenderContext,
  renderMarkdown,
  type ScreenImage,
  stripAnsi,
  type Theme,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { replyRows, userLines, userText } from "./format.ts"
import { glyphs } from "./glyphs.ts"
import { childrenOf, isActive, type SpawnGroups, type SubagentNode, subtree, treeRows } from "./subagents.ts"
import { type CopyRow, chromeRows, gutterRows } from "./text-selection.ts"
import { type FinishedCall, finishedToolLines, type PresenterSource, runningToolLines } from "./tool-view.ts"
import type { BlockKind } from "./transcript.ts"

/** What blocks need to draw themselves, the same for every block of a frame. */
export interface BlockEnv {
  theme: Theme
  width: number
  now: number
  /** The glyph running tools show. */
  spinner: string
  /** How much of finished tool calls is shown, unless a block was folded or unfolded. */
  detail: ToolDetailLevel
  presenters: PresenterSource | undefined
  hyperlinks: boolean
  /** Every sub-agent seen, by id; tool calls draw theirs from here. */
  nodes: Map<string, SubagentNode>
  /** Spawn groups by id; a compact one's members show as one line. */
  groups?: SpawnGroups
  /** Where replies get their images, when the terminal draws them; without it, alt text. */
  images?: BlockImages
}

/** What replies need to show their images (D83): the same object for every frame. */
export interface BlockImages {
  loader: ImageLoader
  /** Something a block shows changed by itself (an image came in): a frame is wanted. */
  changed: () => void
}

/** An image in a block's lines: from `line`, its rows blank, drawn at `col` over them. */
export interface ImageRow {
  line: number
  col: number
  image: ScreenImage
  /** What shows in its place when it cannot be drawn: its alt text, as a row. */
  alt: string
}

/** The images in lines a block returned, by those lines. */
const lineImages = new WeakMap<readonly string[], ImageRow[]>()

/** The images in lines a block returned, if any. */
export function imagesIn(lines: readonly string[]): ImageRow[] | undefined {
  return lineImages.get(lines)
}

/**
 * Rows that stand for rows of an image while a reply is laid out (content cannot make one: the
 * nonce is not known, and escape sequences are taken out of replies); blank once laid out.
 */
const NONCE = Math.random().toString(36).slice(2, 10)
const MARK = new RegExp(`^( *)\\x1b_amira:img:${NONCE}:(\\d+):(\\d+)\\x07$`)
const mark = (id: number, row: number) => `\x1b_amira:img:${NONCE}:${id}:${row}\x07`

let nextId = 1

/**
 * A block of the full-screen transcript: a user message, a reply, a tool call, a notice, and
 * so on. It keeps what it shows rather than lines, so it can be drawn again at any width and
 * change in place (a call finishing, its sub-agents moving on). The transcript caches its
 * lines by width and `version`, and draws blocks that are `live` afresh on every frame.
 */
export abstract class Block {
  readonly id = nextId++
  abstract readonly kind: BlockKind
  /** Bumped whenever what the block shows changes, so its cached lines are drawn again. */
  version = 0
  /** Its position in the transcript, kept by the transcript. */
  index = -1

  /** Whether its lines change by themselves (a spinner, an elapsed time): drawn every frame. */
  get live(): boolean {
    return false
  }

  abstract lines(env: BlockEnv): string[]

  /** The text "copy selected block" puts on the clipboard. */
  abstract copyText(): string

  /**
   * How each of its lines copies when text is selected with the mouse: `lines` as `lines`
   * returned them, `plain` the same without styles. By default the symbols in front of rows
   * (bullets, trees, result marks) are chrome.
   */
  copyRows(plain: readonly string[], _lines: readonly string[]): CopyRow[] {
    return chromeRows(plain)
  }

  /** Whether folding it shows less; folding does nothing to other blocks. */
  foldable(_env: BlockEnv): boolean {
    return false
  }

  /** Folds or unfolds it; only called when `foldable`. */
  toggleFold(_env: BlockEnv): void {}

  /** Whether it was folded or unfolded by hand, so it shows other than it would inline. */
  get refolded(): boolean {
    return false
  }

  /** Its lines as the inline transcript shows them, whatever it was folded to: what exiting prints. */
  printLines(env: BlockEnv): string[] {
    return this.lines(env)
  }

  touch(): void {
    this.version++
  }
}

/** A block drawn by a function of the width: the banner, notices, echoes, separators. */
export class LinesBlock extends Block {
  constructor(
    readonly kind: BlockKind,
    private draw: (width: number, theme: Theme) => string[],
    private copy?: string,
  ) {
    super()
  }

  lines(env: BlockEnv): string[] {
    return this.draw(env.width, env.theme)
  }

  copyText(): string {
    return this.copy ?? ""
  }

  override copyRows(plain: readonly string[]): CopyRow[] {
    // A message and a command echo sit behind "› ", their rows lined up after it.
    if (this.kind === "user" || this.kind === "command")
      return gutterRows(plain, visibleWidth(glyphs.user) + 1)
    return chromeRows(plain)
  }
}

/** A line drawn as it is, wrapped when the screen is narrower. */
export function fixedLine(kind: BlockKind, line: string): LinesBlock {
  return new LinesBlock(kind, (width) => wrapText(line, Math.max(1, width)), stripAnsi(line))
}

export function userBlock(message: UserMessage): LinesBlock {
  const text = message.display?.text.trim() || userText(message)
  return new LinesBlock("user", (width, theme) => userLines(theme, message, width), text)
}

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
  /** The images the stream was made to draw with, if any. */
  private streamImages: BlockImages | undefined
  private streamImageRows = 0
  /** Images laid out by their marks' ids, with their alt text. */
  private marks = new Map<number, { image: ScreenImage; alt: string }>()
  #hasImages = false
  #streaming: boolean
  private lastImages: BlockImages | undefined
  /** An image file came in (or failed): its rows change. */
  private readonly imageLoaded = () => {
    this.stream = undefined
    this.touch()
    this.lastImages?.changed()
  }

  constructor(
    source: string,
    streaming: boolean,
    private hyperlinks: boolean,
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
    const width = Math.max(1, env.width - visibleWidth(glyphs.assistant))
    // Folded, images are their alt text.
    const images = this.folded ? undefined : env.images
    this.lastImages = images
    const opts: MarkdownStreamOptions = { hyperlinks: this.hyperlinks }
    if (images) opts.imageRows = (image, fallback, col, w) => this.imageRows(images, image, fallback, col, w)
    const imageRows = images ? images.loader.maxRows() : 0
    let rows: string[]
    if (this.#streaming && !this.folded) {
      if (
        !this.stream ||
        this.streamWidth !== width ||
        this.streamImages !== images ||
        this.streamImageRows !== imageRows
      ) {
        // Images are laid out afresh with it: only those of its rows are kept.
        this.marks.clear()
        this.stream = new MarkdownStream(opts)
        this.stream.append(this.source)
        this.streamWidth = width
        this.streamImages = images
        this.streamImageRows = imageRows
      }
      const ctx: RenderContext = { theme: env.theme, color: true, rows: Number.POSITIVE_INFINITY }
      rows = this.stream.render(width, ctx)
      while (rows.length && rows[rows.length - 1]!.trim() === "") rows = rows.slice(0, -1)
    } else {
      // Its marks are laid out afresh: a stream made before (folded while streaming) starts over.
      this.stream = undefined
      this.marks.clear()
      const { text } = foldMarkdown(this.source, this.folded)
      rows = renderMarkdown(text, width, env.theme, opts)
    }
    return this.layOut(replyRows(rows), images !== undefined)
  }

  /** The rows an image takes: its marks, once its size is known; its alt text until then. */
  private imageRows(
    images: BlockImages,
    ref: { url: string; alt: string },
    fallback: string[],
    col: number,
    width: number,
  ): string[] {
    const source = images.loader.screen(ref.url)
    if (!source) return fallback
    if (source.state === "loading") source.onSettled(this.imageLoaded)
    const image = source.image(Math.max(1, width - col), images.loader.maxRows())
    if (!image) return fallback
    const indent = " ".repeat(col)
    const first = fallback[0] ?? ""
    const alt = first.startsWith(indent) ? first.slice(col) : first
    this.marks.set(image.id, { image, alt })
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
        })
    }
    this.#hasImages = found.length > 0
    if (found.length) lineImages.set(lines, found)
    return lines
  }

  copyText(): string {
    return this.source.trim()
  }

  /**
   * Its rows copy without the reply's indent. Code blocks copy as their code: the frame rows
   * are left out, the side before each row too, and a line of code wrapped over rows is one
   * line again (matched against the source; if they do not match, its rows stay lines). An
   * image copies as its alt text, once.
   */
  override copyRows(plain: readonly string[], lines: readonly string[]): CopyRow[] {
    const indent = visibleWidth(glyphs.assistant)
    const rows: CopyRow[] = plain.map(() => ({ from: indent }))
    const frames = codeFrames(plain)
    const fences = fencedCode(foldMarkdown(this.source, this.folded).text)
    frames.forEach((f, i) => {
      rows[f.top] = { from: 0, skip: true }
      if (f.bottom !== undefined) rows[f.bottom] = { from: 0, skip: true }
      const source = frames.length === fences.length ? fences[i] : undefined
      const joins =
        source &&
        wrapsOf(
          f.rows.map((r) => plain[r]!.slice(f.col)),
          source,
        )
      for (const [k, r] of f.rows.entries())
        rows[r] = joins?.[k] ? { from: f.col, joins: true } : { from: f.col }
    })
    for (const im of imagesIn(lines) ?? []) {
      const text = stripAnsi(im.alt).trim()
      for (let k = 0; k < im.image.rows && im.line + k < rows.length; k++)
        rows[im.line + k] = k ? { from: 0, text, repeats: true } : { from: 0, text }
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

  override get refolded(): boolean {
    return this.folded
  }

  override printLines(env: BlockEnv): string[] {
    const folded = this.folded
    this.folded = false
    try {
      return this.lines(env)
    } finally {
      this.folded = folded
    }
  }
}

/** A code block's frame in a reply's rows: its top and bottom rows, its code rows, and the column its code starts at. */
interface CodeFrame {
  top: number
  bottom?: number
  rows: number[]
  col: number
}

/** The frames of code blocks in rows of rendered Markdown (without styles). */
function codeFrames(plain: readonly string[]): CodeFrame[] {
  const { codeTop, codeSide, codeBottom } = defaultGlyphs
  const out: CodeFrame[] = []
  for (let i = 0; i < plain.length; i++) {
    const col = /^ */.exec(plain[i]!)![0].length
    if (!plain[i]!.startsWith(codeTop, col)) continue
    const frame: CodeFrame = { top: i, rows: [], col: col + visibleWidth(codeSide) + 1 }
    out.push(frame)
    const pad = " ".repeat(col)
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

/** The lines of each fenced code block of Markdown, in order (the last one maybe still open). */
function fencedCode(markdown: string): string[][] {
  const out: string[][] = []
  let fence: { mark: string; indent: number; lines: string[] } | undefined
  for (const line of markdown.split("\n")) {
    if (fence) {
      const close = FENCE.exec(line)
      if (
        close &&
        close[1]![0] === fence.mark[0] &&
        close[1]!.length >= fence.mark.length &&
        !line.trim().slice(close[1]!.length).trim()
      ) {
        fence = undefined
        continue
      }
      let start = 0
      while (start < fence.indent && line[start] === " ") start++
      fence.lines.push(line.slice(start))
      continue
    }
    const open = FENCE.exec(line)
    if (open) {
      fence = { mark: open[1]!, indent: /^ */.exec(line)![0].length, lines: [] }
      out.push(fence.lines)
    }
  }
  return out
}

/**
 * Which rows of a code block continue the line before them, found by matching the rows to the
 * lines of its source. Undefined when they do not match.
 */
function wrapsOf(rows: string[], source: string[]): boolean[] | undefined {
  const joins = rows.map(() => false)
  let r = 0
  for (const line of source) {
    if (r >= rows.length) break
    let text = rows[r++]!
    while (r < rows.length && text.length < line.length && rows[r] && line.startsWith(text + rows[r])) {
      text += rows[r]
      joins[r++] = true
    }
    if (text.trimEnd() !== line.trimEnd()) return undefined
  }
  return r === rows.length ? joins : undefined
}

/** A tool call: its head, its output while it runs, then its result, with its sub-agents under it. */
export class ToolBlock extends Block {
  readonly kind = "tool"
  startedAt: number | undefined
  partial: ToolResult | undefined
  end:
    | { result: ToolResult; durationMs?: number; rejected?: ToolRejection; interrupted?: boolean }
    | undefined
  /** Set by folding it: how much of it shows, whatever the global level. */
  folding: ToolDetailLevel | undefined

  constructor(
    readonly callId: string,
    public name: string,
    public args: Record<string, unknown>,
    /** The session that made the call; its sub-agents are found by it. */
    readonly session: string,
  ) {
    super()
  }

  /** A call the reply asked for but that did not start yet takes no room. */
  get started(): boolean {
    return this.startedAt !== undefined || this.end !== undefined
  }

  /** Whether it or one of its sub-agents still runs. Checked against the nodes when drawn. */
  running = false

  override get live(): boolean {
    return this.running
  }

  /** The sub-agents it started, and theirs, depth first. */
  tree(nodes: Map<string, SubagentNode>): SubagentNode[] {
    return childrenOf(nodes, this.session, this.callId).flatMap((n) => subtree(nodes, n))
  }

  detail(env: BlockEnv): ToolDetailLevel {
    return this.folding ?? env.detail
  }

  lines(env: BlockEnv): string[] {
    const tree = this.tree(env.nodes)
    this.running = this.started && (!this.end || tree.some(isActive))
    if (!this.started) return []
    const presenter = env.presenters?.get(this.name)
    const { theme, width, now } = env
    if (!this.end) {
      const call = {
        name: this.name,
        args: this.args,
        startedAt: this.startedAt!,
        ...(this.partial ? { partial: this.partial } : {}),
      }
      return [
        ...runningToolLines(theme, presenter, call, now, env.spinner, width),
        ...treeRows(tree, now, width, theme, env.groups),
      ]
    }
    const detail = this.detail(env)
    const lines = finishedToolLines(theme, presenter, this.finished(), detail, width)
    let rows: string[]
    if (detail === "collapsed" && this.folding === "collapsed" && tree.length) {
      const running = tree.filter(isActive).length
      const text = `${tree.length} sub-agent${tree.length === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}`
      rows = [
        truncateToWidth(
          `  ${theme.muted(glyphs.treeBranch)} ${theme.accent(glyphs.subagent)} ${theme.muted(text)}`,
          width,
          glyphs.more,
        ),
      ]
    } else {
      // The call's own result line comes after them, so only a nested one can close a level.
      rows = treeRows(tree, now, width, theme, env.groups, false)
    }
    lines.splice(1, 0, ...rows)
    return lines
  }

  finished(): FinishedCall {
    const end = this.end!
    return {
      name: this.name,
      args: this.args,
      result: end.result,
      ...(end.durationMs !== undefined ? { durationMs: end.durationMs } : {}),
      ...(end.rejected ? { rejected: end.rejected } : {}),
      interrupted: end.interrupted ?? false,
    }
  }

  copyText(): string {
    const head = `${this.name} ${JSON.stringify(this.args)}`
    if (!this.end) return head
    return `${head}\n${toolResultText(this.end.result)}`.trim()
  }

  override foldable(): boolean {
    return this.end !== undefined
  }

  override toggleFold(env: BlockEnv): void {
    this.folding = this.detail(env) === "full" ? "collapsed" : "full"
    this.touch()
  }

  override get refolded(): boolean {
    return this.folding !== undefined
  }

  override printLines(env: BlockEnv): string[] {
    const folding = this.folding
    this.folding = undefined
    try {
      return this.lines(env)
    } finally {
      this.folding = folding
    }
  }
}

/**
 * Sub-agents started without a tool call of this session (by a command, say), under a small
 * head: one, or the members of one spawn group (a compact group's show as its one line).
 */
export class SubagentGroupBlock extends Block {
  readonly kind = "tool"
  running = true
  /** The sub-agents it shows, with theirs, in start order. */
  readonly roots: string[]

  constructor(root: string) {
    super()
    this.roots = [root]
  }

  override get live(): boolean {
    return this.running
  }

  lines(env: BlockEnv): string[] {
    const list = this.roots.flatMap((id) => {
      const node = env.nodes.get(id)
      return node ? subtree(env.nodes, node) : []
    })
    if (!list.length) return []
    this.running = list.some(isActive)
    const head = `${env.theme.accent(glyphs.subagent)} ${env.theme.muted("background")}`
    return [
      truncateToWidth(head, env.width, glyphs.more),
      ...treeRows(list, env.now, env.width, env.theme, env.groups),
    ]
  }

  copyText(): string {
    return ""
  }
}
