import { stripAnsi } from "../ansi.ts"
import { supportsHyperlinks } from "../capabilities.ts"
import type { Component, RenderContext } from "../component.ts"
import { defaultGlyphs, type Glyphs } from "../glyphs.ts"
import type { ImageBlock } from "../images/encode.ts"
import { pendingImage } from "../images/placement.ts"
import {
  type BlockState,
  cloneState,
  commitOpenBlocks,
  type Env,
  endOpenBlocks,
  finish,
  hasOpenBlock,
  heldUndecided,
  type LineRender,
  newState,
  partialRender,
  renderLine,
  type Sink,
  step,
} from "../markdown/blocks.ts"
import { codeCarry } from "../markdown/highlight.ts"
import { type Lead, type LeadPart, markdownStyles, type Run } from "../markdown/inline.ts"
import { defaultTheme, type Theme } from "../style.ts"
import { TAB_WIDTH, textWidth } from "../width.ts"

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
/** An escape sequence or `\r\n` that a chunk may end in the middle of. */
const UNFINISHED =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
  /(?:\x1b(?:\[[0-?]*[ -/]*|[\]P_^X][^\x07\x1b]*\x1b?|[ -/]*)?|\r)$/

export interface MarkdownStreamOptions {
  glyphs?: Glyphs
  /** Make links clickable with OSC 8. Defaults to what the terminal is known to support. */
  hyperlinks?: boolean
  /** Color keywords, strings and comments in code blocks of the languages it knows. */
  highlight?: boolean
  /**
   * Shows images that stand on a line of their own: committed as the image once it is loaded (the
   * renderer holds what follows back until then), as its alt text while loading and instead of it
   * when it fails or takes too long. Without it, images are only their alt text.
   */
  images?: MarkdownImages
  /**
   * Without `images`: the rows an image standing on a line of its own shows as, given its rows
   * as alt text (`fallback`), its column and the width. For views that draw images themselves.
   */
  imageRows?: (
    image: { url: string; alt: string },
    fallback: string[],
    col: number,
    width: number,
  ) => string[]
}

/** Where a Markdown stream gets its images. */
export interface MarkdownImages {
  /** The image at `url`, fitted to `maxCols` columns; undefined when it cannot be shown. */
  load(url: string, maxCols: number): Promise<ImageBlock | undefined>
  /** How long a committed image may take to load before its alt text goes instead. Default 3 s. */
  waitMs?: number
}

/** Renders a whole Markdown text to rows, as `MarkdownStream` shows it once it has streamed in. */
export function renderMarkdown(
  text: string,
  width: number,
  theme: Theme = defaultTheme,
  opts: MarkdownStreamOptions = {},
): string[] {
  const m = new MarkdownStream(opts)
  m.append(text)
  m.render(width, { theme, color: true, rows: Number.POSITIVE_INFINITY })
  return m.take(width)
}

/** The start of a partial line whose first rows were committed already. */
interface Cut {
  render: LineRender
  /** Delimiters of the spans open at the cut, parsed again in front of the rest. */
  carry: string
  /** The rest of a run the cut went through. */
  lead?: Lead
}

/**
 * Markdown that streams in, such as a model's reply, rendered block by block so that nothing
 * shown in the scrollback ever has to change.
 *
 * A block is committed to the scrollback as soon as it is complete: a paragraph line once the
 * next line shows it is not a heading's text or a table's header, a heading, list item or quote
 * line at its line break, a table when a line that is not a row follows, and each line of a code
 * block as soon as it ends. Only the block still being written is drawn in the live region,
 * re-rendered each frame, so the work per frame is bounded by that block and a width change
 * re-wraps only it. When it grows past `maxRows`, its rows that can no longer change are
 * committed too (like `StreamText`): a table then keeps the column widths it had.
 *
 * Source line breaks are kept. Committing needs the renderer's `ctx.commit`; without it every
 * row is returned. Escape sequences and control characters in the text are dropped.
 */
export class MarkdownStream implements Component {
  /** Rows the text may take in the live region; set by the parent before each render. */
  maxRows = Number.POSITIVE_INFINITY
  /** Rows committed to the scrollback since the text was last taken. */
  committedRows = 0
  private readonly glyphs: Glyphs
  private readonly hyperlinks: boolean
  private readonly highlight: boolean
  private readonly images: MarkdownImages | undefined
  private readonly imageRows: MarkdownStreamOptions["imageRows"]
  private state = newState()
  /** Text not processed yet: complete lines, then the partial line being written. */
  private src = ""
  /** Where the rest of the partial line starts, when its first rows were committed. */
  private cut: Cut | undefined
  /** Rows finished while no renderer could commit them. */
  private done: string[] = []
  /** The end of the last chunk when it may continue in the next: a split escape or `\r`. */
  private pending = ""
  private theme = defaultTheme

  constructor(opts: MarkdownStreamOptions = {}) {
    this.glyphs = opts.glyphs ?? defaultGlyphs
    this.hyperlinks = opts.hyperlinks ?? supportsHyperlinks()
    this.highlight = opts.highlight ?? true
    this.images = opts.images
    this.imageRows = opts.imageRows
  }

  /** Adds streamed text. */
  append(chunk: string): void {
    let s = this.pending + chunk
    this.pending = s.match(UNFINISHED)?.[0] ?? ""
    if (this.pending) s = s.slice(0, -this.pending.length)
    s = stripAnsi(s).replace(/\r\n?/g, "\n").replace(CONTROLS, "")
    if (!s.includes("\t")) {
      this.src += s
      return
    }
    for (const part of s.split(/(\t)/)) {
      if (part !== "\t") {
        this.src += part
        continue
      }
      // Measured from the text, not summed per chunk: a chunk may end inside a grapheme.
      const col = textWidth(this.src.slice(this.src.lastIndexOf("\n") + 1))
      this.src += " ".repeat(TAB_WIDTH - (col % TAB_WIDTH))
    }
  }

  render(width: number, ctx: RenderContext): string[] {
    this.theme = ctx.theme
    // Rows that cannot be committed now are shown live, so they get no image markers.
    const env = this.env(width, !!ctx.commit)
    const liveEnv = ctx.commit ? this.env(width, false) : env
    const sink: Sink = ctx.commit
      ? (rows) => {
          ctx.commit!(rows)
          this.committedRows += rows.length
        }
      : (rows) => this.done.push(...rows)
    if (ctx.commit && this.done.length) sink(this.done.splice(0))
    this.processLines(env, sink)
    let live = this.live(liveEnv)
    if (ctx.commit && live.length > this.maxRows) {
      // A held line that the partial line may still make a table header or a heading is not
      // committed as a paragraph: the partial line is left out of view until it is complete.
      const held = !this.cut && heldUndecided(this.state, this.src) ? this.live(env, "") : undefined
      if (held && held.length <= this.maxRows) live = held
      else if (hasOpenBlock(this.state)) {
        commitOpenBlocks(this.state, env, sink)
        live = this.live(liveEnv)
      }
      if (live.length > this.maxRows && this.commitPartial(env, sink)) live = this.live(liveEnv)
    }
    return this.done.length ? [...this.done, ...live] : live
  }

  /**
   * Returns the rows not committed yet, rendered to `width` as the end of the text (an unclosed
   * code block is closed), without trailing blank rows, and starts over empty.
   */
  take(width: number): string[] {
    const env = this.env(width)
    const rows = this.done
    const sink: Sink = (r) => rows.push(...r)
    if (this.src !== "" && !this.src.endsWith("\n")) this.src += "\n"
    this.processLines(env, sink)
    finish(this.state, env, sink)
    while (rows.length > 0 && rows[rows.length - 1]!.trim() === "") rows.pop()
    this.state = newState()
    this.src = ""
    this.cut = undefined
    this.done = []
    this.pending = ""
    this.committedRows = 0
    return rows
  }

  /** What rendering needs; with `commit`, standalone images become markers for the renderer. */
  private env(width: number, commit = true): Env {
    const env: Env = {
      width: Math.max(1, width),
      styles: markdownStyles(this.theme),
      glyphs: this.glyphs,
      hyperlinks: this.hyperlinks,
      highlight: this.highlight,
      refs: this.state.refs,
    }
    const images = this.images
    if (images) {
      env.image = (image, rows, col) => {
        // Asked for while it is live too, so it is often ready by the time it is committed.
        const load = images.load(image.url, Math.max(1, env.width - col))
        if (!commit) return rows
        const indent = " ".repeat(col)
        const fallback = rows.map((r) => (r.startsWith(indent) ? r.slice(col) : r))
        return [indent + pendingImage(load, fallback, images.waitMs ?? 3000)]
      }
    } else if (this.imageRows) {
      const rowsFor = this.imageRows
      env.image = (image, rows, col) => rowsFor(image, rows, col, env.width)
    }
    return env
  }

  /** Processes the complete lines, leaving the partial one. */
  private processLines(env: Env, sink: Sink) {
    let from = 0
    for (;;) {
      const nl = this.src.indexOf("\n", from)
      if (nl === -1) break
      const line = this.src.slice(from, nl)
      if (this.cut) {
        sink(renderLine(this.cut.render, line, env, this.cut.carry, this.cut.lead).rows)
        this.cut = undefined
      } else step(this.state, line, env, sink)
      from = nl + 1
    }
    if (from > 0) this.src = this.src.slice(from)
  }

  /** The rows of what is still open, as they would render if the text ended with `line`. */
  private live(env: Env, line = this.src): string[] {
    if (this.cut)
      return line !== "" ? renderLine(this.cut.render, line, env, this.cut.carry, this.cut.lead).rows : []
    const rows: string[] = []
    const sink: Sink = (r) => rows.push(...r)
    const s = cloneState(this.state)
    if (line !== "") step(s, line, env, sink)
    endOpenBlocks(s, env, sink)
    return rows
  }

  /**
   * Commits the rows of the partial line that can no longer change, keeping the last; returns
   * whether it did. Spans open at the cut are carried over, so the rest renders as it would have.
   *
   * Rows are cut before a delimiter that may still open a span, and not inside a URL (whose link
   * would then point at its start), unless the rows kept for that would not fit in `maxRows`.
   */
  private commitPartial(env: Env, sink: Sink): boolean {
    const line = this.src
    let render: LineRender
    let state: BlockState | undefined
    let carry: string | undefined
    let lead: Lead | undefined
    if (this.cut) {
      render = this.cut.render
      carry = this.cut.carry
      lead = this.cut.lead
    } else {
      const p = partialRender(this.state, line, env)
      if (!p) return false
      if (p.raw) {
        // Shown differently from now on, as its source: a change even if no row can be committed.
        this.cut = { render: p.render, carry: "" }
        this.commitPartial(env, sink)
        return true
      }
      render = p.render
      state = p.state
    }
    const r = renderLine(render, line, env, carry, lead)
    const skip = carry?.length ?? 0
    /** The cell rows `[0, n)` would be cut before, if they can be. */
    const cutAt = (n: number) => {
      const row = r.layout[n - 1]!
      const cell = r.cells[row.next]
      return row.stable && cell && cell.src >= skip ? cell : undefined
    }
    let n = r.layout.length - 1
    for (; n > 0; n--) {
      const cell = cutAt(n)
      if (cell && r.runs[cell.run]!.cuttable && cell.src <= r.open) break
    }
    if (r.layout.length - n > this.maxRows) {
      for (let m = r.layout.length - 1; m > n; m--) {
        const cell = cutAt(m)
        if (cell && (r.runs[cell.run]!.cuttable || r.runs[cell.run]!.rest)) {
          n = m
          break
        }
      }
    }
    if (n === 0) return false
    const cell = r.cells[r.layout[n - 1]!.next]!
    if (state) {
      // Committed rows follow a pending blank line like any others.
      const blank = state.blankPending && state.emitted
      state.blankPending = false
      state.emitted = true
      this.state = state
      if (blank) sink([""])
    }
    sink(r.rows.slice(0, n))
    this.cut = cutInside(render, r.runs, cell.run, cell.src, skip)
    return true
  }
}

/** Where the rest of a line starts after a cut before the cell at `src` of `runs[index]`. */
function cutInside(render: LineRender, runs: Run[], index: number, src: number, skip: number): Cut {
  const run = runs[index]!
  const off = src - run.src
  const at = (to: number) => ({ ...render, start: render.start + to - skip, prefix: render.rest })
  if (run.cuttable) return { render: at(src), carry: render.code ? codeCarry(run, off) : run.carry }
  const style = run.style ? { style: run.style } : {}
  if (run.rest?.url) {
    const lead: Lead = { url: true, head: run.rest.head + run.text.slice(0, off), ...style }
    return { render: at(src), carry: run.carry, lead }
  }
  // Text of its own: it goes on from where the cut left it, the source where the run ends. The
  // runs of added text after it at the same place (an image's URL after its alt text) go on
  // too: the source from there on does not have them.
  const resume = run.rest!.resume
  const parts: LeadPart[] = [part(run, run.text.slice(off))]
  for (let i = index + 1; i < runs.length; i++) {
    const next = runs[i]!
    if (next.cuttable || next.rest?.url !== false || next.rest.resume !== resume) break
    parts.push(part(next, next.text))
  }
  const lead: Lead = { url: false, parts, len: Math.max(0, resume - src) }
  return { render: at(Math.min(src, resume)), carry: run.carry, lead }
}

function part(run: Run, text: string): LeadPart {
  return { text, ...(run.style ? { style: run.style } : {}), ...(run.link ? { link: run.link } : {}) }
}
