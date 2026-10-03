import type { ToolDetailLevel, UserMessage } from "@amira/api"
import {
  type ImageStore,
  type ScreenImage,
  stripAnsi,
  type Theme,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { userLines, userText } from "../format.ts"
import { glyphs } from "../glyphs.ts"
import type { ReplyRenderers } from "../markdown-nodes.ts"
import type { SpawnGroups, SubagentNode } from "../subagents.ts"
import { type CopyRow, chromeRows, gutterRows } from "../text-selection.ts"
import type { PresenterSource } from "../tool-view.ts"
import { type BlockKind, type NoticeLevel, noticeDetailLines, noticeLines } from "../transcript.ts"

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
  /** Nodes of replies extensions render (D88); without it, replies are Markdown as it renders. */
  renders?: BlockRenders
  /** Output lines a successful shell command shows at `summary` detail (tui.shellOutputLines). */
  outputLines?: number
}

/** What replies need to show their images (D83): the same object for every frame. */
export interface BlockImages {
  store: ImageStore
  /** Something a block shows changed by itself (an image came in): a frame is wanted. */
  changed: () => void
}

/** What replies need for the nodes extensions render (D88): the same object for every frame. */
export interface BlockRenders {
  renders: ReplyRenderers
  /** A rendering came in: a frame is wanted. */
  changed: () => void
}

/** An image in a block's lines: from `line`, its rows blank, drawn at `col` over them. */
export interface ImageRow {
  line: number
  col: number
  image: ScreenImage
  /** What shows in its place when it cannot be drawn: its alt text, as a row. */
  alt: string
  /** Text retained for copying an extension-rendered image. */
  fallback?: string[]
  /** Invalidate its layout if encoding fails and the fallback needs a different row count. */
  changed?: () => void
}

/** Accessible text for an image that is loading, broken, or cannot be drawn at this crop. */
export function setImageFallback(
  rows: Map<number, string>,
  at: number,
  image: Pick<ImageRow, "col" | "alt" | "fallback">,
  height: number,
  width: number,
  note = "",
): void {
  if (!image.fallback) {
    rows.set(at, `${" ".repeat(image.col)}${image.alt}${note}`)
    return
  }
  const text = image.fallback
  for (let i = 0; i < Math.min(height, text.length); i++)
    rows.set(
      at + i,
      " ".repeat(image.col) +
        truncateToWidth(text[i]! + (i ? "" : note), Math.max(1, width - image.col), glyphs.more),
    )
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
export const MARK = new RegExp(`^( *)\\x1b_amira:img:${NONCE}:(\\d+):(\\d+)\\x07$`)
export const mark = (id: number, row: number) => `\x1b_amira:img:${NONCE}:${id}:${row}\x07`

export function setImagesIn(lines: readonly string[], images: ImageRow[]): void {
  lineImages.set(lines, images)
}

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

  /** Whether folding it now would unfold it: it shows less than it can. */
  isFolded(_env: BlockEnv): boolean {
    return false
  }

  /** What a block selection calls it: "reply", "tool call", ... */
  get label(): string {
    return BLOCK_LABELS[this.kind]
  }

  /** The sub-agents it shows, with theirs, depth first: what the sub-agent viewer opens on. */
  subagents(_env: BlockEnv): SubagentNode[] {
    return []
  }

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

/** What a block selection calls blocks, by kind. */
const BLOCK_LABELS: Record<BlockKind, string> = {
  banner: "banner",
  user: "message",
  assistant: "reply",
  tool: "tool call",
  notice: "notice",
  command: "command",
  "command-output": "command output",
  dialog: "answer",
  history: "session",
  summary: "summary",
  reasoning: "thinking",
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
    if (this.kind !== "user" && this.kind !== "command") return chromeRows(plain)
    // A message or a command echo sits behind "› ", its rows lined up after it.
    const gutter = visibleWidth(glyphs.user) + 1
    const rows: CopyRow[] = gutterRows(plain, gutter)
    // On the band behind them its blank rows above and below are chrome too (and the fill
    // that runs each row to the edge is trailing blanks, which never copy).
    const last = plain.length - 1
    if (last > 0 && !plain[0]!.trim()) rows[0] = { from: 0, skip: true }
    if (last > 0 && !plain[last]!.trim()) rows[last] = { from: 0, skip: true }
    return rows
  }
}

/**
 * A notice with details that stay folded (e.g. the provider's raw answer to a failed request):
 * they show once unfolded, or at the full tool output level.
 */
export class DetailNoticeBlock extends Block {
  readonly kind = "notice" as const
  #open: boolean | undefined

  constructor(
    readonly level: NoticeLevel,
    readonly text: string,
    readonly detail: string,
  ) {
    super()
  }

  #shown(env: BlockEnv): boolean {
    return this.#open ?? env.detail === "full"
  }

  lines(env: BlockEnv): string[] {
    const head = noticeLines(env.theme, this.level, this.text, env.width)
    return this.#shown(env)
      ? [...head, ...noticeDetailLines(env.theme, this.level, this.detail, env.width)]
      : head
  }

  copyText(): string {
    return `${this.text}\n${this.detail}`
  }

  override foldable(): boolean {
    return true
  }

  override toggleFold(env: BlockEnv): void {
    this.#open = !this.#shown(env)
    this.touch()
  }

  override get refolded(): boolean {
    return this.#open !== undefined
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
