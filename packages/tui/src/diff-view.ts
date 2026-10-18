import { plural, type ToolLine } from "@amira/api"
import {
  type Component,
  graphemes,
  type RenderContext,
  type StyleFn,
  stripAnsi,
  TAB_WIDTH,
  type Theme,
  textWidth,
  themeToken,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"
import { type Range, wordDiff } from "./word-diff.ts"

const SIGNS: Partial<Record<ToolLine["kind"], string>> = {
  "diff-add": "+",
  "diff-remove": "-",
  "diff-context": " ",
}

/**
 * Rows a long diff line wraps to at most, the last one ending in "…" when there is more: the
 * limits on a body count lines, so a line may not take many more rows than one.
 */
export const MAX_DIFF_LINE_ROWS = 4

/** Marks the gap between two hunks, in the line number column. */
export const HUNK_GAP = "⋯"

function styleOf(kind: ToolLine["kind"], theme: Theme): StyleFn {
  switch (kind) {
    case "diff-add":
    case "success":
      return theme.success
    case "diff-remove":
    case "error":
      return theme.error
    case "accent":
      return theme.accent
    case "warning":
      return theme.warning
    case "code":
      return themeToken(theme, "fg2") ?? theme.muted
    case "text":
    // A diff's unchanged lines read as the code they are; its signs and numbers are muted.
    case "diff-context":
      return theme.text
    default:
      // Notes and hunk gaps recede behind the conversation.
      return theme.muted
  }
}

const FILE_HEADER = /^(?:--- |\+\+\+ |diff )/

/** Tabs as spaces to the next multiple of TAB_WIDTH, as the terminal and Markdown code draw them. */
export function expandTabs(line: string): string {
  if (!line.includes("\t")) return line
  let out = ""
  for (const part of line.split(/(\t)/)) {
    out += part === "\t" ? " ".repeat(TAB_WIDTH - (textWidth(out) % TAB_WIDTH)) : part
  }
  return out
}

/**
 * A line of program output as a terminal leaves it: escape sequences out, a carriage return
 * starting the line over (progress output such as "10%\r45%\r99%" shows as "99%"; the one of a
 * CRLF goes), a backspace taking back the character before it, tabs to their stops. Line
 * breaks inside it become spaces: a row is one line.
 */
export function terminalText(text: string): string {
  const one = (line: string) => {
    let s = line.replace(/\r+$/, "")
    if (s.includes("\r")) {
      const parts = s.split("\r")
      s = parts.findLast((p) => p !== "") ?? ""
    }
    if (s.includes("\b")) {
      const chars: string[] = []
      for (const c of s) {
        if (c === "\b") chars.pop()
        else chars.push(c)
      }
      s = chars.join("")
    }
    return expandTabs(s)
  }
  return stripAnsi(text).split("\n").map(one).join(" ")
}

function cleanText(text: string): string {
  return terminalText(text)
}

/** Host-only layout of newline fragments; not part of the extension ToolLine contract. */
export interface ToolLayoutLine extends ToolLine {
  hangingIndent?: number
  /** Set by the Markdown registry for later fragments of one marked logical label. */
  continuationMarker?: ToolLine["marker"]
}

/**
 * Presenter lines as terminal rows, each fitted to `width` after `indent`.
 *
 * Diff lines get a gutter as wide as the largest line number (muted), their sign, and wrap
 * rather than being cut, their continued rows keeping the gutter. When the theme has the diff
 * surface colors, context uses the code surface and changed lines use their diff surface to
 * the right edge, with success/error signs; in a
 * removed line followed by the added line that replaced it, the words that changed are on a
 * stronger one; otherwise they are colored as text, the signs saying what they are (so they
 * read without colors too). A hunk gap shows as "⋯" in the number column unless a view passes
 * its own decoration. Other lines take one row each, cut to the width, unless the presenter
 * requests wrapping. Marked rows keep their glyph separate from the text's color and hang
 * descriptions under the label.
 */
export function renderToolLines(
  lines: ToolLayoutLine[],
  theme: Theme,
  width: number,
  indent = "",
  onWrap?: (row: number, join: "" | " ") => void,
  onRow?: (row: number, from: number) => void,
  view?: ViewMarkers,
): string[] {
  // Views pass their own decorations; they can be wider than the legacy one-cell marker, and
  // both the last kept wrap row and the gap must reserve their real display width. Callers
  // that pass nothing keep the historical glyphs and one-cell reservation.
  const marker = view?.ellipsis ?? glyphs.more
  const reserve = view === undefined ? 1 : textWidth(view.ellipsis)
  const gap = view?.gap ?? HUNK_GAP
  const isView = view !== undefined
  const numbered = lines.filter((l) => l.lineNo !== undefined)
  const gutter = numbered.length ? Math.max(...numbered.map((l) => String(l.lineNo).length)) : 0
  const texts = lines.map((l) => cleanText(l.text))
  // Words are only marked on their own background: without it, no need to compare them.
  const words = themeToken(theme, "diffAddedWordBg") ? changedWords(lines, texts) : new Map<number, Range[]>()
  const signed = lines.some((l) => SIGNS[l.kind] !== undefined)
  const out: string[] = []
  const append = (rows: string[], from = visibleWidth(indent)) => {
    for (const row of rows) {
      onRow?.(out.length, from)
      out.push(row)
    }
  }
  lines.forEach((l, i) => {
    const text = texts[i]!
    const sign = SIGNS[l.kind]
    if (sign !== undefined) {
      append(
        diffRows(l, text, sign, words.get(i) ?? [], {
          theme,
          width,
          indent,
          gutter,
          marker,
          reserve,
          view: isView,
        }),
      )
      return
    }
    if (l.wrap || l.marker || l.description !== undefined || l.hangingIndent || l.continuationMarker) {
      const offset = out.length
      const record = onWrap && ((row: number, join: "" | " ") => onWrap(offset + row, join))
      const content = onRow && ((row: number, from: number) => onRow(offset + row, from))
      // A live answer can wrap to hundreds of thousands of rows: never pass them as arguments.
      for (const row of presenterRows(l, text, theme, width, indent, record, content)) out.push(row)
      return
    }
    if (l.kind === "diff-hunk" && (text === "⋮" || text.startsWith(HUNK_GAP))) {
      // The mark in the number column, what follows it (a function's name) lined up with the text.
      const about = text.startsWith(HUNK_GAP) ? text.slice(HUNK_GAP.length).trim() : ""
      const mark = gutter ? `${" ".repeat(Math.max(0, gutter - textWidth(gap)))}${gap}` : gap
      const at = about ? `${mark}${" ".repeat(signed ? 3 : 1)}${about}` : mark
      append([`${indent}${theme.muted(truncateToWidth(at, Math.max(1, width - indent.length), marker))}`])
      return
    }
    // A file's header starts at the edge, above the numbers of its lines; other lines (a note
    // such as "… 12 more lines") line up with the text of the diff lines around them.
    const header = l.kind === "muted" && FILE_HEADER.test(text)
    const no = header ? "" : `${gutter ? `${" ".repeat(gutter)} ` : ""}${signed ? "  " : ""}`
    const prefix = `${indent}${no}`
    const row = truncateToWidth(`${prefix}${text}`, width, marker)
    const style = header ? (themeToken(theme, "path") ?? theme.muted) : styleOf(l.kind, theme)
    // As in the signed-diff branch, a view's wider marker can start inside the gutter: keep
    // the clipped row whole instead of restoring an untruncated prefix over it.
    append([
      isView && reserve > 1 && !row.startsWith(prefix)
        ? theme.muted(row)
        : `${indent}${theme.muted(no)}${style(row.slice(prefix.length))}`,
    ])
  })
  // Narrower than the indent and the gutter: cut, as the terminal would otherwise wrap them.
  // Views keep their marker whole when that cut reaches it.
  return out.map((r) =>
    visibleWidth(r) > width ? truncateToWidth(r, Math.max(0, width), isView && reserve > 1 ? marker : "") : r,
  )
}

/** Wrapped presenter prose and choices, with descriptions and glyphs styled independently. */
function presenterRows(
  line: ToolLayoutLine,
  text: string,
  theme: Theme,
  width: number,
  indent: string,
  onWrap?: (row: number, join: "" | " ") => void,
  onRow?: (row: number, from: number) => void,
): string[] {
  const continuation = line.continuationMarker ? visibleWidth(`${glyphs[line.continuationMarker]} `) : 0
  indent += " ".repeat(line.hangingIndent ?? continuation)
  const marker = line.marker ? glyphs[line.marker] : ""
  const lead = marker ? `${marker} ` : ""
  const hanging = " ".repeat(visibleWidth(lead))
  const room = Math.max(1, width - visibleWidth(indent) - visibleWidth(lead))
  const labelRows = wrapText(text, room, room, onWrap)
  const style = styleOf(line.kind, theme)
  const rows = labelRows.map((row, i) => {
    onRow?.(i, visibleWidth(indent) + (i ? visibleWidth(hanging) : 0))
    return `${indent}${i ? hanging : line.marker === "success" ? theme.success(lead) : theme.muted(lead)}${style(row)}`
  })
  if (line.description) {
    const description = cleanText(line.description)
    if (rows.length === 1 && visibleWidth(text) + 2 + visibleWidth(description) <= room) {
      rows[0] += theme.muted(`  ${description}`)
    } else {
      const offset = rows.length
      const record = onWrap && ((row: number, join: "" | " ") => onWrap(offset + row, join))
      for (const [i, row] of wrapText(description, room, room, record).entries()) {
        onRow?.(offset + i, visibleWidth(indent + hanging))
        rows.push(`${indent}${hanging}${theme.muted(row)}`)
      }
    }
  }
  return rows
}

/**
 * The changed words of removed lines and the added lines right after them, paired in order:
 * the first removed line with the first added one, and so on.
 */
function changedWords(lines: ToolLine[], texts: string[]): Map<number, Range[]> {
  const out = new Map<number, Range[]>()
  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.kind !== "diff-remove") {
      i++
      continue
    }
    let j = i
    while (j < lines.length && lines[j]!.kind === "diff-remove") j++
    let k = j
    while (k < lines.length && lines[k]!.kind === "diff-add") k++
    for (let n = 0; n < Math.min(j - i, k - j); n++) {
      const d = wordDiff(texts[i + n]!, texts[j + n]!)
      if (!d) continue
      out.set(i + n, d.before)
      out.set(j + n, d.after)
    }
    i = k
  }
  return out
}

interface Layout {
  theme: Theme
  width: number
  indent: string
  gutter: number
  /** The marker for a line cut to the width; views pass their own three-cell marker. */
  marker: string
  /** Cells the marker takes on the last kept wrap row. */
  reserve: number
  /** Views clip rows themselves, so a clipped gutter must not overwrite their marker. */
  view: boolean
}

/** Decorations a view draws instead of the transcript's historical ones. */
export interface ViewMarkers {
  /** Ends the last row kept when a line wraps past MAX_DIFF_LINE_ROWS. */
  ellipsis: string
  /** Stands in for the lines between two hunks. */
  gap: string
}

/** A piece of a line's text, and whether it is a changed word. */
interface Piece {
  text: string
  word: boolean
}

/** The rows of one diff line: gutter, sign and text, wrapped with the gutter continued. */
function diffRows(l: ToolLine, text: string, sign: string, words: Range[], at: Layout): string[] {
  const { theme, width, indent, gutter } = at
  const add = l.kind === "diff-add"
  const remove = l.kind === "diff-remove"
  const bg = add
    ? themeToken(theme, "diffAddedBg")
    : remove
      ? themeToken(theme, "diffRemovedBg")
      : themeToken(theme, "codeBg")
  const wordBg = add
    ? themeToken(theme, "diffAddedWordBg")
    : remove
      ? themeToken(theme, "diffRemovedWordBg")
      : undefined
  const no = gutter
    ? `${l.lineNo === undefined ? " ".repeat(gutter) : String(l.lineNo).padStart(gutter)} `
    : ""
  const head = `${sign} `
  const lead = visibleWidth(no) + head.length
  const room = width - visibleWidth(indent) - lead
  if (room < 4) {
    // Too narrow to wrap in: one row cut to the width, as other lines.
    const prefix = `${indent}${no}${head}`
    const row = truncateToWidth(`${prefix}${text}`, width, at.marker)
    // A view's wider marker can start inside the gutter: keep the clipped row whole rather
    // than restoring an untruncated gutter over it. One-cell markers keep the old path.
    if (at.view && at.reserve > 1 && !row.startsWith(prefix)) return [theme.muted(row)]
    const body = row.slice(indent.length + no.length)
    return [`${indent}${theme.muted(no)}${styleOf(l.kind, theme)(body)}`]
  }
  const rows = wrapPieces(pieces(text, words), room, at.reserve, at.marker)
  const blankNo = " ".repeat(no.length)
  return rows.map((pieceRow, r) => {
    const gut = ((bg && themeToken(theme, "surfaceMuted")) || theme.muted)(r === 0 ? no : blankNo)
    const mark = r === 0 ? head : "  "
    const used = pieceRow.reduce((n, p) => n + visibleWidth(p.text), 0)
    if (bg) {
      const body = pieceRow.map((p) => (p.word && wordBg ? wordBg(p.text) : p.text)).join("")
      return `${indent}${bg(`${gut}${r === 0 ? (add ? theme.success : remove ? theme.error : theme.muted)(mark) : mark}${body}${" ".repeat(Math.max(0, room - used))}`)}`
    }
    const body = pieceRow.map((p) => p.text).join("")
    return `${indent}${gut}${styleOf(l.kind, theme)(`${mark}${body}`)}`
  })
}

/** `text` cut into pieces at the changed words' ranges. */
function pieces(text: string, words: Range[]): Piece[] {
  const out: Piece[] = []
  let at = 0
  for (const [start, end] of words) {
    if (start > at) out.push({ text: text.slice(at, start), word: false })
    if (end > start) out.push({ text: text.slice(start, end), word: true })
    at = Math.max(at, end)
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at), word: false })
  return out
}

/**
 * Pieces wrapped to rows of `room` cells, breaking anywhere (code, not prose) but never inside
 * a character: a wide one that does not fit goes to the next row. More than
 * MAX_DIFF_LINE_ROWS rows are cut, the last one ending in "…".
 */
function wrapPieces(list: Piece[], room: number, reserve: number, more: string): Piece[][] {
  const rows: Piece[][] = [[]]
  let used = 0
  const put = (g: string, word: boolean) => {
    const row = rows[rows.length - 1]!
    const last = row[row.length - 1]
    if (last && last.word === word) last.text += g
    else row.push({ text: g, word })
  }
  for (const p of list) {
    for (const g of graphemes(p.text)) {
      const w = textWidth(g)
      if (used + w > room && used > 0) {
        rows.push([])
        used = 0
      }
      put(g, p.word)
      used += w
    }
  }
  if (rows.length <= MAX_DIFF_LINE_ROWS) return rows
  const kept = rows.slice(0, MAX_DIFF_LINE_ROWS)
  // The last row kept, cut to leave the marker's cells for it.
  const last = kept[kept.length - 1]!
  const cut: Piece[] = []
  let left = room - reserve
  for (const p of last) {
    let text = ""
    for (const g of graphemes(p.text)) {
      const w = textWidth(g)
      if (w > left) break
      text += g
      left -= w
    }
    if (text) cut.push({ text, word: p.word })
    if (text.length < p.text.length) break
  }
  cut.push({ text: more, word: false })
  kept[kept.length - 1] = cut
  return kept
}

/**
 * A unified diff as presenter lines: file headers muted, then +, - and context lines numbered
 * from the hunk headers (the new file's numbers, the old one's for removed lines), with "⋯"
 * between the hunks of a file in place of their headers (followed by what a header says the
 * hunk is in). Lines of a hunk are counted, so a removed "-- x" is not taken for a file header.
 */
export function parseUnifiedDiff(diff: string): ToolLine[] {
  const out: ToolLine[] = []
  let oldNo: number | undefined
  let newNo: number | undefined
  /** Lines of the open hunk still to come, from its header: until then no line is a header. */
  let oldLeft = 0
  let newLeft = 0
  /** A hunk of the current file came before, so the next header is a gap. */
  let inFile = false
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    const inHunk = oldLeft > 0 || newLeft > 0
    if (!inHunk && (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff "))) {
      out.push({ kind: "muted", text: line })
      inFile = false
      oldNo = undefined
      newNo = undefined
      continue
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line)
    if (hunk) {
      // What the header says the hunk is in (a function's name) stays, after the gap mark.
      const about = hunk[5]!.trim()
      if (inFile || about) out.push({ kind: "diff-hunk", text: about ? `${HUNK_GAP} ${about}` : HUNK_GAP })
      inFile = true
      oldNo = Number(hunk[1])
      newNo = Number(hunk[3])
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
      continue
    }
    if (line.startsWith("+")) newLeft--
    else if (line.startsWith("-")) oldLeft--
    else if (line.startsWith(" ")) {
      oldLeft--
      newLeft--
    }
    if (line.startsWith("@@")) {
      out.push({ kind: "diff-hunk", text: line })
      continue
    }
    const number = (n: number | undefined) => (n === undefined ? {} : { lineNo: n })
    if (line.startsWith("+")) {
      out.push({ kind: "diff-add", text: line.slice(1), ...number(newNo) })
      if (newNo !== undefined) newNo++
    } else if (line.startsWith("-")) {
      out.push({ kind: "diff-remove", text: line.slice(1), ...number(oldNo) })
      if (oldNo !== undefined) oldNo++
    } else if (line.startsWith(" ")) {
      out.push({ kind: "diff-context", text: line.slice(1), ...number(newNo) })
      if (newNo !== undefined) newNo++
      if (oldNo !== undefined) oldNo++
    } else if (line.startsWith("\\")) out.push({ kind: "muted", text: line })
    else out.push({ kind: "text", text: line })
  }
  return out
}

/** A diff cut to `maxLines`, with a line saying how many more there are. */
export class DiffView implements Component {
  constructor(
    private lines: ToolLine[],
    public maxLines = Number.POSITIVE_INFINITY,
  ) {}

  render(width: number, ctx: RenderContext): string[] {
    const shown = this.lines.length > this.maxLines ? this.lines.slice(0, this.maxLines) : this.lines
    const out = renderToolLines(shown, ctx.theme, width)
    if (shown.length < this.lines.length) {
      out.push(ctx.theme.muted(`${glyphs.more} ${plural(this.lines.length - shown.length, "more line")}`))
    }
    return out
  }
}
