import type { Glyphs } from "../glyphs.ts"
import type { StyleFn } from "../style.ts"
import { truncateToWidth, visibleWidth, wrapText } from "../width.ts"
import { highlightLine } from "./highlight.ts"
import {
  type ImageRef,
  type Lead,
  type LinkRef,
  type MarkdownStyles,
  normalizeLabel,
  parseInline,
  parseLine,
  type Run,
} from "./inline.ts"
import { type Cell, cellText, type Row, toCells, wrapCells } from "./layout.ts"

/** What rendering needs besides the text. */
export interface Env {
  width: number
  styles: MarkdownStyles
  glyphs: Glyphs
  hyperlinks: boolean
  highlight: boolean
  /** Reference definitions seen so far; the block state's, set by the functions here. */
  refs?: ReadonlyMap<string, LinkRef>
  /**
   * Shows a paragraph line that is only an image (maybe inside a link) as the image: gets the
   * image, the rows the line renders as, and its column; returns the rows to emit instead.
   */
  image?: (image: Required<ImageRef>, rows: string[], col: number) => string[]
  /**
   * Whether a code block in `lang` is rendered by `code`: its lines are held until it closes
   * (shown live as code meanwhile), then `code` gets its text and the rows it renders as.
   */
  claimsCode?: (lang: string) => boolean
  code?: (block: CodeBlock, rows: string[], col: number) => string[]
}

/** A fenced code block's language, info string and text (without the fences). */
export interface CodeBlock {
  lang: string
  info: string
  code: string
}

/**
 * How one source line renders as wrapped rows: `line.slice(start)` parsed as inline Markdown
 * (or highlighted as code), after `prefix` on the first row and `rest` on the others. Both are
 * `indent` cells wide.
 */
export interface LineRender {
  code: boolean
  lang: string
  base?: StyleFn
  prefix: string
  rest: string
  indent: number
  start: number
  /**
   * Where a heading's text starts in the line: its closing `#`s and trailing blanks are not shown.
   * Kept when `start` moves past the first rows, since the line may still grow.
   */
  heading?: number
}

interface ListEntry {
  /** Column in the source where the item's content starts; lines indented this far belong to it. */
  contentCol: number
  /** Column on screen where the item's content starts. */
  renderCol: number
}

interface Fence {
  char: string
  len: number
  indent: number
  lang: string
  info: string
  renderCol: number
  /** The lines so far of a block `Env.code` renders, held until it closes. */
  held?: string[]
}

type Align = "left" | "center" | "right"

interface Table {
  renderCol: number
  aligns: Align[]
  /** Header first, then the body rows; not the delimiter row. Emptied once frozen. */
  rows: string[][]
  /** The source lines, delimiter row included, for when the table is too wide to lay out. */
  lines: string[]
  /** Set once rows are committed before the table ended: the column widths used, or raw lines. */
  frozen?: number[] | "raw"
}

/** Where the block structure stands after the lines processed so far. */
export interface BlockState {
  list: ListEntry[]
  fence?: Fence
  table?: Table
  /** A paragraph line kept back one line: the next may turn it into a heading or a table header. */
  held?: { text: string; renderCol: number }
  /**
   * The last line, with a `|`, was committed early as a paragraph (it did not fit the live
   * region): a delimiter row next still makes it a table header, the table shown as its source.
   */
  header?: { text: string; renderCol: number }
  prevBlank: boolean
  /** The last line was paragraph text, held or committed early: a definition cannot follow it. */
  paragraph: boolean
  /** Reference definitions (`[label]: url`) seen so far, by normalized label. */
  refs: Map<string, LinkRef>
  /** A blank line is due before the next rows, unless nothing was shown yet. */
  blankPending: boolean
  emitted: boolean
  /**
   * The ordered lists still going on, by the source column of their items: the number the next
   * item shows and the delimiter after it. Items are numbered from the first one's number on,
   * whatever numbers they were written with ("1. 1. 1." shows as 1. 2. 3.).
   */
  ordinals: Map<number, { next: number; delimiter: string }>
}

export type Sink = (rows: string[]) => void

export function newState(): BlockState {
  return {
    list: [],
    prevBlank: false,
    paragraph: false,
    refs: new Map(),
    blankPending: false,
    emitted: false,
    ordinals: new Map(),
  }
}

export function cloneState(s: BlockState): BlockState {
  const c: BlockState = {
    ...s,
    list: s.list.map((e) => ({ ...e })),
    refs: new Map(s.refs),
    ordinals: new Map([...s.ordinals].map(([k, v]) => [k, { ...v }])),
  }
  if (s.fence) c.fence = { ...s.fence, ...(s.fence.held ? { held: [...s.fence.held] } : {}) }
  if (s.table) c.table = { ...s.table, rows: [...s.table.rows], lines: [...s.table.lines] }
  if (s.held) c.held = { ...s.held }
  if (s.header) c.header = { ...s.header }
  return c
}

const FENCE_OPEN = /^(`{3,}|~{3,})\s*(.*)$/
const FENCE_CLOSE_LIKE = /^\s*(`+|~+)\s*$/
const RULE = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const HEADING = /^(#{1,6})(?:[ \t]+|$)/
const ITEM = /^([-*+]|\d{1,9}[.)])([ \t]+|$)/
const TASK = /^\[([ xX])\][ \t]+/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const DELIMITER_CELL = /^:?-+:?$/
/** A reference definition: `[label]: url`, maybe in <>, maybe with a title. */
const DEFINITION =
  /^[ \t]*\[([^\]]*[^\]\s][^\]]*)\]:[ \t]*<?([^\s<>]+)>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/
/** The start of a line that may be an image and nothing else. */
const IMAGE_START = /^[ \t]*\[?!\[/
/** The start of a line that is, or may still become, a reference definition. */
const DEFINITION_START = /^[ \t]*\[(?:[^\]]*$|[^\]]+\](?::|$))/
/** A table column is not narrowed below this many cells to fit the screen. */
const MIN_COLUMN = 8

function emit(s: BlockState, sink: Sink, rows: string[]) {
  if (rows.length === 0) return
  if (s.blankPending && s.emitted) sink([""])
  s.blankPending = false
  s.emitted = true
  sink(rows)
}

const pad = (n: number) => " ".repeat(Math.max(0, n))

/** A row of a code block's frame at `col`, cut to the width. */
function frameRow(col: number, text: string, env: Env): string {
  return truncateToWidth(pad(col) + env.styles.codeFrame(text), env.width, "…")
}

/** The environment with the state's reference definitions. */
function withRefs(s: BlockState, env: Env): Env {
  return env.refs === s.refs ? env : { ...env, refs: s.refs }
}

/** Processes one complete source line (without its `\n`). */
export function step(s: BlockState, line: string, env: Env, sink: Sink): void {
  env = withRefs(s, env)
  const header = takeHeader(s)
  if (s.fence) {
    const f = s.fence
    const m = line.match(FENCE_CLOSE_LIKE)
    if (m && m[1]![0] === f.char && m[1]!.length >= f.len) {
      s.fence = undefined
      emit(s, sink, f.held ? closeHeld(f, env) : [frameRow(f.renderCol, env.glyphs.codeBottom, env)])
      return
    }
    if (f.held) f.held.push(line)
    else emit(s, sink, renderLine(codeLine(f, line, env), line, env).rows)
    return
  }
  if (line.trim() === "") {
    endOpenBlocks(s, env, sink)
    s.blankPending = true
    s.prevBlank = true
    s.paragraph = false
    return
  }
  // A reference definition cannot interrupt a paragraph: there it is paragraph text.
  const inParagraph = s.paragraph
  s.paragraph = false
  if (s.held) {
    const h = s.held
    if (line.includes("|") && h.text.includes("|")) {
      const aligns = delimiterRow(line)
      const header = splitRow(h.text)
      if (aligns && aligns.length === header.length) {
        s.held = undefined
        s.table = { renderCol: h.renderCol, aligns, rows: [header], lines: [h.text, line.trim()] }
        s.prevBlank = false
        return
      }
    }
    const setext = line.match(SETEXT)
    if (setext) {
      s.held = undefined
      s.blankPending = true
      const lr = headingRender(setext[1]![0] === "=" ? 1 : 2, h.renderCol, env)
      emit(s, sink, renderLine(lr, h.text, env).rows)
      s.prevBlank = false
      return
    }
    flushHeld(s, env, sink)
  }
  if (header && startRawTable(s, header, line)) {
    emit(s, sink, rawRows(s.table!, [line.trim()], env))
    return
  }
  if (s.table) {
    if (line.includes("|")) {
      addTableRow(s, s.table, line.trim(), env, sink)
      return
    }
    flushTable(s, env, sink)
  }
  const def = !inParagraph && line.match(DEFINITION)
  if (def) {
    // Not shown; links and images further on use it. The first definition of a label wins.
    const label = normalizeLabel(def[1]!)
    if (!s.refs.has(label)) s.refs.set(label, { url: def[2]! })
    s.prevBlank = false
    return
  }
  const d = classify(s, line, env)
  s.prevBlank = false
  if (d.rows) emit(s, sink, d.rows)
  else if (d.hold) {
    s.held = { text: line.slice(d.render.start), renderCol: d.render.indent }
    s.paragraph = true
  } else emit(s, sink, renderLine(d.render, line, env).rows)
}

function takeHeader(s: BlockState): BlockState["header"] {
  const header = s.header
  s.header = undefined
  return header
}

/**
 * Starts a table whose header was committed as a paragraph, when `line` is its delimiter row.
 * The header shows as its source already, so the table goes on as its source lines.
 */
function startRawTable(s: BlockState, header: NonNullable<BlockState["header"]>, line: string): boolean {
  const aligns = line.includes("|") ? delimiterRow(line) : undefined
  if (!aligns || aligns.length !== splitRow(header.text).length) return false
  s.table = { renderCol: header.renderCol, aligns, rows: [], lines: [], frozen: "raw" }
  s.prevBlank = false
  s.paragraph = false
  return true
}

/**
 * Updates the state after the complete `line`, whose rows were committed in parts as `lr` says
 * rather than by `step`: a paragraph line may have been a table header, or a header's delimiter row.
 */
export function endCut(s: BlockState, line: string, lr: LineRender): void {
  const header = takeHeader(s)
  if (lr.code || !s.paragraph || s.table || !line.includes("|")) return
  if (header && startRawTable(s, header, line)) return
  s.header = { text: line.trimStart(), renderCol: lr.indent }
}

/** Ends the blocks that a blank line or the end of the text closes: a held paragraph line, a table. */
export function endOpenBlocks(s: BlockState, env: Env, sink: Sink): void {
  env = withRefs(s, env)
  flushHeld(s, env, sink)
  flushTable(s, env, sink)
}

/** Ends everything at the end of the text, closing an unclosed code block too. */
export function finish(s: BlockState, env: Env, sink: Sink): void {
  env = withRefs(s, env)
  endOpenBlocks(s, env, sink)
  if (s.fence) {
    const f = s.fence
    s.fence = undefined
    emit(s, sink, f.held ? closeHeld(f, env) : [frameRow(f.renderCol, env.glyphs.codeBottom, env)])
  }
}

/**
 * The rows of a held code block that is still open, as they show live: as a code block so far,
 * without its bottom. None when no block is held.
 */
export function heldCode(s: BlockState, env: Env, sink: Sink): void {
  const f = s.fence
  if (!f?.held) return
  emit(s, sink, heldRows(f, withRefs(s, env), false))
}

/** Whether a code block is held open (`Env.code` renders it once it closes). */
export function holdsCode(s: BlockState): boolean {
  return s.fence?.held !== undefined
}

/** A held code block's rows as a code block: its frame's top, its lines, and the bottom once closed. */
function heldRows(f: Fence, env: Env, closed: boolean): string[] {
  const label = f.lang ? ` ${f.lang}` : ""
  const rows = [frameRow(f.renderCol, env.glyphs.codeTop + label, env)]
  for (const line of f.held!) rows.push(...renderLine(codeLine(f, line, env), line, env).rows)
  if (closed) rows.push(frameRow(f.renderCol, env.glyphs.codeBottom, env))
  return rows
}

/** A held code block that closed: what `Env.code` makes of it, given its rows as a code block. */
function closeHeld(f: Fence, env: Env): string[] {
  const rows = heldRows(f, env, true)
  if (!env.code) return rows
  const code = f.held!.map((line) => {
    let start = 0
    while (start < f.indent && line[start] === " ") start++
    return line.slice(start)
  })
  return env.code({ lang: f.lang, info: f.info, code: code.join("\n") }, rows, f.renderCol)
}

/** Whether a held line or an open table would be committed by `endOpenBlocks`. */
export function hasOpenBlock(s: BlockState): boolean {
  return s.held !== undefined || (s.table !== undefined && s.table.frozen === undefined)
}

/**
 * Whether the partial `line` may still turn the held line into a table header or a setext heading
 * once it is complete: it is the start of a delimiter row or of an underline.
 */
export function heldUndecided(s: BlockState, line: string): boolean {
  if (!s.held || line.trim() === "") return false
  if (SETEXT.test(line)) return true
  return s.held.text.includes("|") && /^[ \t]*[|:-][|:\- \t]*$/.test(line)
}

/**
 * Commits what is open early, because it no longer fits: a held line as a paragraph, and a table
 * as laid out so far, fixing its column widths for the rows still to come.
 */
export function commitOpenBlocks(s: BlockState, env: Env, sink: Sink): void {
  env = withRefs(s, env)
  const h = s.held
  flushHeld(s, env, sink)
  if (h?.text.includes("|")) s.header = h
  const t = s.table
  if (t && !t.frozen) {
    const { rows, widths } = layoutTable(t, env, true)
    t.frozen = widths ?? "raw"
    // The rows were only kept for this layout: the later ones are committed as they come.
    t.rows = []
    t.lines = []
    emit(s, sink, rows)
  }
}

/**
 * How a partial line would render, for committing its first rows before it is complete, and the
 * state it leaves. Undefined for lines that do not render as wrapped text (rules, fences) or that
 * may still turn into something else.
 */
export function partialRender(
  s: BlockState,
  line: string,
  env: Env,
): { state: BlockState; render: LineRender; raw?: boolean } | undefined {
  if (hasOpenBlock(s) || line.trim() === "") return undefined
  if (s.fence)
    return FENCE_CLOSE_LIKE.test(line) || s.fence.held
      ? undefined
      : { state: s, render: codeLine(s.fence, line, env) }
  // A row of a table whose widths are frozen, too tall to wait for its end: its cells may still
  // grow, so its rows cannot be committed as table rows. It is shown as its source instead (`raw`:
  // not as it renders now), and the table goes on with the next row.
  if (s.table && line.includes("|")) return { state: s, render: rawRender(s.table, line), raw: true }
  // It may be a reference definition, which is not shown.
  if (DEFINITION_START.test(line)) return undefined
  // It may be an image on its own, shown once the line is complete.
  if (env.image && IMAGE_START.test(line)) return undefined
  const next = cloneState(s)
  next.table = undefined
  const d = classify(next, line, env)
  next.prevBlank = false
  next.paragraph = !!d.hold
  if (d.rows) return undefined
  return { state: next, render: d.render }
}

type Classified =
  | { rows: string[]; hold?: undefined }
  | { rows?: undefined; hold: boolean; render: LineRender }

/** Sorts a line outside code blocks into its block, updating the list nesting and opening fences. */
function classify(s: BlockState, line: string, env: Env): Classified {
  const indent = line.length - line.trimStart().length
  const body = line.slice(indent)
  const { styles, glyphs } = env
  const fence = body.match(FENCE_OPEN)
  const validFence = fence && !(fence[1]![0] === "`" && fence[2]!.includes("`"))
  const rule = RULE.test(body)
  const heading = !rule && body.match(HEADING)
  const quote = body.startsWith(">")
  const item = !rule && body.match(ITEM)
  const para = !validFence && !rule && !heading && !quote && !item
  if (s.list.length && (s.prevBlank || !para)) {
    while (s.list.length && s.list[s.list.length - 1]!.contentCol > indent) s.list.pop()
  }
  // Something other than an item at this column ends the ordered lists from here in (a lazy
  // continuation line of an item's paragraph does not).
  if ((s.prevBlank || !para) && !item) endOrdinals(s, indent)
  const col = s.list.length ? s.list[s.list.length - 1]!.renderCol : 0
  if (validFence) {
    const info = fence[2]!.trim()
    const lang = info.split(/\s+/)[0] ?? ""
    s.fence = { char: fence[1]![0]!, len: fence[1]!.length, indent, lang, info, renderCol: col }
    // Rendered by someone else once it closes: nothing shows until then but live rows.
    if (lang && env.code && env.claimsCode?.(lang)) {
      s.fence.held = []
      return { rows: [] }
    }
    const label = lang ? ` ${lang}` : ""
    return { rows: [frameRow(col, glyphs.codeTop + label, env)] }
  }
  if (rule) {
    const at = col < env.width ? col : 0
    const n = Math.max(1, Math.floor((env.width - at) / Math.max(1, visibleWidth(glyphs.rule))))
    return { rows: [pad(at) + styles.rule(glyphs.rule.repeat(n))] }
  }
  if (heading) {
    // A heading is set apart from what came before, even without a blank line in the source.
    s.blankPending = true
    const level = heading[1]!.length
    const lr = headingRender(level, col, env)
    lr.start = indent + heading[0].length
    lr.heading = lr.start
    return { hold: false, render: lr }
  }
  if (quote) {
    let depth = 0
    let at = indent
    while (line[at] === ">") {
      depth++
      at++
      if (line[at] === " ") at++
      while (line[at] === " " && line[at + 1] === ">") at++
    }
    const bars = `${styles.quoteBar(glyphs.quoteBar)} `.repeat(depth)
    const prefix = pad(col) + bars
    const barWidth = visibleWidth(glyphs.quoteBar) + 1
    return {
      hold: false,
      render: {
        code: false,
        lang: "",
        base: styles.quote,
        prefix,
        rest: prefix,
        indent: col + depth * barWidth,
        start: at,
      },
    }
  }
  if (item) {
    let marker = item[1]!
    const ordered = /\d/.test(marker)
    // Deeper lists end with an item out here; so does an ordered list at this column when an
    // item of another kind comes.
    endOrdinals(s, indent + 1)
    if (ordered) {
      const delimiter = marker.slice(-1)
      const going = s.ordinals.get(indent)
      const n = going && going.delimiter === delimiter ? going.next : Number(marker.slice(0, -1))
      s.ordinals.set(indent, { next: n + 1, delimiter })
      marker = `${n}${delimiter}`
    } else {
      s.ordinals.delete(indent)
      marker = glyphs.bullets[Math.min(s.list.length, glyphs.bullets.length - 1)] ?? "•"
    }
    let start = indent + item[0].length
    const spaces = item[2]!.length
    const contentCol = indent + item[1]!.length + (spaces > 4 || spaces === 0 ? 1 : spaces)
    let head = styles.listMarker(marker)
    let width = visibleWidth(marker) + 1
    const task = line.slice(start).match(TASK)
    if (task) {
      const done = task[1] !== " "
      head += ` ${done ? styles.listMarker(glyphs.taskDone) : glyphs.taskOpen}`
      width += visibleWidth(done ? glyphs.taskDone : glyphs.taskOpen) + 1
      start += task[0].length
    }
    s.list.push({ contentCol, renderCol: col + width })
    const prefix = `${pad(col)}${head} `
    return {
      hold: false,
      render: { code: false, lang: "", prefix, rest: pad(col + width), indent: col + width, start },
    }
  }
  return {
    hold: true,
    render: { code: false, lang: "", prefix: pad(col), rest: pad(col), indent: col, start: indent },
  }
}

/** Ends the ordered lists whose items are at column `from` or further in. */
function endOrdinals(s: BlockState, from: number): void {
  for (const col of s.ordinals.keys()) if (col >= from) s.ordinals.delete(col)
}

function headingRender(level: number, col: number, env: Env): LineRender {
  const base =
    level === 1
      ? (env.styles.heading1 ?? env.styles.heading)
      : level === 2
        ? env.styles.heading
        : env.styles.subheading
  return { code: false, lang: "", base, prefix: pad(col), rest: pad(col), indent: col, start: 0 }
}

function codeLine(f: Fence, line: string, env: Env): LineRender {
  let start = 0
  while (start < f.indent && line[start] === " ") start++
  const side = `${pad(f.renderCol)}${env.styles.codeFrame(env.glyphs.codeSide)} `
  const indent = f.renderCol + visibleWidth(env.glyphs.codeSide) + 1
  return { code: true, lang: f.lang, prefix: side, rest: side, indent, start }
}

function flushHeld(s: BlockState, env: Env, sink: Sink) {
  const h = s.held
  if (!h) return
  s.held = undefined
  const lr: LineRender = {
    code: false,
    lang: "",
    prefix: pad(h.renderCol),
    rest: pad(h.renderCol),
    indent: h.renderCol,
    start: 0,
  }
  const rows = renderLine(lr, h.text, env).rows
  const image = env.image && standaloneImage(h.text, env)
  emit(s, sink, image ? env.image!(image, rows, h.renderCol) : rows)
}

/** The image a line holds and nothing else (but a link around it), when it has a target. */
function standaloneImage(text: string, env: Env): Required<ImageRef> | undefined {
  if (!IMAGE_START.test(text)) return undefined
  const runs = parseInline(text, {
    styles: env.styles,
    hyperlinks: false,
    ...(env.refs ? { refs: env.refs } : {}),
  })
  const images = runs.filter((r) => r.image)
  const image = images[0]?.image
  if (images.length !== 1 || image?.url === undefined) return undefined
  // Everything else is added text (the URLs), not text of the line.
  if (runs.some((r) => r.cuttable && r.text.trim() !== "")) return undefined
  return { url: image.url, alt: image.alt }
}

export interface Rendered {
  rows: string[]
  cells: Cell[]
  runs: Run[]
  layout: Row[]
  /** The parsed text: `carry` followed by the line from `start`. */
  carry: string
  /** Offset in the parsed text from which the rows may still change as the line goes on. */
  open: number
}

/** A heading's closing `#`s, or the blanks at its end. */
const HEADING_CLOSE = /(?:^|[ \t]+)#+[ \t]*$|[ \t]+$/

/**
 * Renders a line as `lr` says. With `carry` (the delimiters of spans open where an earlier part
 * of the line was cut off, or the state of the code highlighter there) the text continues from
 * `lr.start` and every row gets `lr.rest`; `lead` is the rest of a run the cut went through.
 */
export function renderLine(lr: LineRender, line: string, env: Env, carry?: string, lead?: Lead): Rendered {
  let end = line.length
  if (lr.heading !== undefined) {
    const closing = line.slice(lr.heading).match(HEADING_CLOSE)
    if (closing) end = Math.max(lr.start, end - closing[0].length)
  }
  const skip = carry?.length ?? 0
  const text = (carry ?? "") + line.slice(lr.start, end)
  let runs: Run[]
  let open = Number.POSITIVE_INFINITY
  if (lr.code) {
    const code = text.slice(skip)
    runs = env.highlight
      ? highlightLine(lr.lang, text, env.styles, skip)
      : code
        ? [{ text: code, src: skip, carry: "", cuttable: true }]
        : []
  } else {
    const parsed = parseLine(text, {
      styles: env.styles,
      hyperlinks: env.hyperlinks,
      imageGlyph: env.glyphs.image,
      ...(env.refs ? { refs: env.refs } : {}),
      ...(lr.base ? { base: lr.base } : {}),
      ...(lead ? { lead, leadAt: skip } : {}),
    })
    runs = parsed.runs
    open = parsed.open
  }
  const cells = toCells(runs)
  let prefix = carry === undefined ? lr.prefix : lr.rest
  let rest = lr.rest
  let room = env.width - lr.indent
  // Too narrow for the indent (a wide character needs two cells): the text gets the whole row.
  if (room < 2) {
    prefix = ""
    rest = ""
    room = env.width
  }
  const layout = wrapCells(cells, room, !lr.code)
  const rows = layout.map((r, i) => {
    const head = i === 0 ? prefix : rest
    return r.end > r.start ? head + cellText(cells, runs, r.start, r.end) : head.trimEnd()
  })
  return { rows, cells, runs, layout, carry: carry ?? "", open }
}

// Tables

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1)
  const cells: string[] = []
  let cell = ""
  let ticks = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === "\\" && s[i + 1] === "|") {
      cell += "|"
      i++
    } else if (c === "`") {
      ticks = ticks ? 0 : 1
      cell += c
    } else if (c === "|" && !ticks) {
      cells.push(cell.trim())
      cell = ""
    } else cell += c
  }
  cells.push(cell.trim())
  return cells
}

function delimiterRow(line: string): Align[] | undefined {
  const cells = splitRow(line)
  if (!cells.every((c) => DELIMITER_CELL.test(c))) return undefined
  return cells.map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left",
  )
}

function addTableRow(s: BlockState, t: Table, line: string, env: Env, sink: Sink) {
  s.prevBlank = false
  if (t.frozen === "raw") emit(s, sink, rawRows(t, [line], env))
  else if (t.frozen) emit(s, sink, tableRow(t, splitRow(line), t.frozen, env, false))
  else {
    t.rows.push(splitRow(line))
    t.lines.push(line)
  }
}

function flushTable(s: BlockState, env: Env, sink: Sink) {
  const t = s.table
  if (!t) return
  s.table = undefined
  if (!t.frozen) emit(s, sink, layoutTable(t, env).rows)
}

function inlineText(text: string, env: Env, base?: StyleFn): string {
  const runs = parseInline(text, {
    styles: env.styles,
    hyperlinks: env.hyperlinks,
    imageGlyph: env.glyphs.image,
    ...(env.refs ? { refs: env.refs } : {}),
    ...(base ? { base } : {}),
  })
  const cells = toCells(runs)
  return cellText(cells, runs, 0, cells.length)
}

/**
 * The table laid out in aligned columns, narrowed to the screen by wrapping the cells of the widest
 * columns, or its raw lines when that would leave the columns too narrow.
 * With `slack`, for widths frozen before the rows still to come are known, each column gets some
 * of the spare room (up to its own width again), so that fewer later cells have to wrap.
 */
function layoutTable(t: Table, env: Env, slack = false): { rows: string[]; widths?: number[] } {
  const n = t.aligns.length
  const widths = Array.from({ length: n }, () => 1)
  for (const [r, row] of t.rows.entries()) {
    for (let c = 0; c < n; c++) {
      const w = visibleWidth(inlineText(row[c] ?? "", env, r === 0 ? env.styles.tableHeader : undefined))
      widths[c] = Math.max(widths[c]!, w)
    }
  }
  const sep = visibleWidth(env.glyphs.tableColumn) + 2
  const room = env.width - t.renderCol - sep * (n - 1)
  const sum = () => widths.reduce((a, b) => a + b, 0)
  if (sum() > room) {
    // Too wide: the widest columns give up room and their cells wrap, unless every column would
    // get too narrow to read; then the table is shown as its source lines.
    const least = widths.map((w) => Math.min(w, MIN_COLUMN))
    if (least.reduce((a, b) => a + b, 0) > room) return { rows: rawRows(t, t.lines, env) }
    let over = sum() - room
    while (over > 0) {
      const widest = Math.max(...widths)
      const next = Math.max(...widths.map((w) => (w < widest ? w : 0)), MIN_COLUMN)
      const cols = widths.flatMap((w, i) => (w === widest ? [i] : []))
      const cut = Math.min(widest - next, Math.ceil(over / cols.length))
      for (const i of cols) {
        if (over <= 0) break
        const by = Math.min(cut, over)
        widths[i] = widest - by
        over -= by
      }
    }
  }
  const total = t.renderCol + sum() + sep * (n - 1)
  if (slack) {
    const share = Math.floor((env.width - total) / n)
    for (let c = 0; c < n; c++) widths[c]! += Math.min(share, Math.max(4, widths[c]!))
  }
  const { styles, glyphs } = env
  const rule = widths
    .map((w) => glyphs.tableRule.repeat(w))
    .join(`${glyphs.tableRule}${glyphs.tableCross}${glyphs.tableRule}`)
  const rows = [
    ...tableRow(t, t.rows[0]!, widths, env, true),
    pad(t.renderCol) + styles.tableBorder(rule),
    ...t.rows.slice(1).flatMap((r) => tableRow(t, r, widths, env, false)),
  ]
  return { rows, widths }
}

/**
 * One table row in columns of `widths`. A cell wider than its column (a row that came after the
 * widths were frozen) wraps within it, making the row taller.
 */
function tableRow(t: Table, cells: string[], widths: number[], env: Env, header: boolean): string[] {
  const texts = widths.map((w, c) => {
    const text = inlineText(cells[c] ?? "", env, header ? env.styles.tableHeader : undefined)
    return visibleWidth(text) > w ? wrapText(text, w) : [text]
  })
  const height = Math.max(...texts.map((l) => l.length))
  const sep = ` ${env.styles.tableBorder(env.glyphs.tableColumn)} `
  const out: string[] = []
  for (let i = 0; i < height; i++) {
    const parts = widths.map((w, c) => {
      const text = texts[c]![i] ?? ""
      const gap = Math.max(0, w - visibleWidth(text))
      const align = t.aligns[c]
      if (align === "right") return pad(gap) + text
      if (align === "center") return pad(Math.floor(gap / 2)) + text + pad(gap - Math.floor(gap / 2))
      return text + (c === widths.length - 1 ? "" : pad(gap))
    })
    const line = pad(t.renderCol) + parts.join(sep)
    // After the screen got narrower than the frozen widths, the row wraps rather than overflowing.
    if (visibleWidth(line) > env.width) out.push(...wrapText(line, env.width))
    else out.push(line.trimEnd())
  }
  return out
}

/** How a table's source line renders when the table is shown raw. */
function rawRender(t: Table, line: string): LineRender {
  const start = line.length - line.trimStart().length
  const col = pad(t.renderCol)
  return { code: false, lang: "", prefix: col, rest: col, indent: t.renderCol, start }
}

function rawRows(t: Table, lines: string[], env: Env): string[] {
  return lines.flatMap((l) => renderLine(rawRender(t, l), l, env).rows)
}
