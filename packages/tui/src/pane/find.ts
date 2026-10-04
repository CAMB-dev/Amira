import { visibleWidth } from "@amira/tui-kit"
import type { Block, BlockEnv } from "../blocks.ts"
import { ESCAPE } from "../text-selection.ts"
import type { Match, PaneRow } from "../transcript-pane.ts"

interface FindView {
  blocks: readonly Block[]
  env(): BlockEnv | undefined
  layout(): readonly PaneRow[]
  following(): boolean
  height(): number
  plain(block: Block, env: BlockEnv): string[]
  drawing(block: Block, env: BlockEnv): object
  gapBefore(index: number, env: BlockEnv): boolean
  moveTo(index: number, offset: number): void
}

/** How often matches are found again while a block changes by itself (a reply streaming). */
const FIND_LIVE_MS = 250

export class PaneFind {
  /** Matches of the find bar, top to bottom; each is a segment per row it covers. */
  private matches: Match[][] = []
  private matchIndex = new Map<Block, Map<number, Match[]>>()
  private current = -1
  private findQuery = ""
  private findWidth = 0
  /** What the matches were found in (see `stamp`). */
  private findStamp = ""
  /** The find bar's matches in a drawing, for the query (as searched) they were found for. */
  private found = new WeakMap<object, { query: string; matches: Match[][] }>()

  constructor(private readonly view: FindView) {}

  refresh(env: BlockEnv): void {
    // The matches follow the text: another width, blocks that came or changed, a reply streaming.
    if (this.findQuery && (this.findWidth !== env.width || this.findStamp !== this.stamp())) this.runFind()
  }

  highlightRow(block: Block, row: number, line: string): string {
    const found = this.matchIndex.get(block)?.get(row)
    if (!found) return line
    const current = this.matches[this.current]
    return highlight(
      line,
      found.map((m) => ({ col: m.col, len: m.len, current: current?.includes(m) ?? false })),
    )
  }

  get findActive(): boolean {
    return this.findQuery !== ""
  }

  get matchCount(): number {
    return this.matches.length
  }

  /** The current match, 1-based from the top, or 0. */
  get matchPosition(): number {
    return this.current + 1
  }

  /**
   * Finds `query` in the text of every block (ignoring case unless it has capitals) and
   * moves to the newest match at or above the bottom of the view.
   */
  find(query: string): void {
    this.findQuery = query
    this.runFind()
    if (!this.matches.length) return
    const bottom = this.view.layout()[this.view.layout().length - 1]
    let pick = this.matches.length - 1
    if (!this.view.following() && bottom) {
      const at = this.matches.findLastIndex(
        ([m]) => m!.block.index < bottom.block.index || (m!.block === bottom.block && m!.line <= bottom.line),
      )
      if (at !== -1) pick = at
    }
    this.jump(pick)
  }

  /** Moves to the match before the current one (up), or after it (`step` 1, down), wrapping. */
  stepMatch(step: -1 | 1): void {
    if (!this.findQuery) return
    this.runFind()
    if (!this.matches.length) return
    const n = this.matches.length
    this.jump(((((this.current < 0 ? n : this.current) + step) % n) + n) % n)
  }

  clearFind(): void {
    this.findQuery = ""
    this.matches = []
    this.matchIndex.clear()
    this.current = -1
  }

  /**
   * Finds the query in each block's text as one run: its rows without their indent, a space
   * between rows (where the text wrapped, the space it broke at; none after a wide character,
   * where CJK text wraps without one), a blank row a break no match
   * crosses. So a match does not depend on where the width wraps the text; one that goes over
   * rows is a segment on each. The current match stays the one it was, where it still is.
   */
  private runFind(): void {
    const env = this.view.env()
    const was = this.matches[this.current]?.[0]
    this.matches = []
    this.matchIndex.clear()
    if (!env || !this.findQuery) return
    this.findWidth = env.width
    this.findStamp = this.stamp()
    const exact = this.findQuery !== this.findQuery.toLowerCase()
    const q = exact ? this.findQuery : this.findQuery.toLowerCase()
    for (const block of this.view.blocks) {
      // Found again only in blocks drawn anew (streaming, changed): rerunning stays cheap.
      const d = this.view.drawing(block, env)
      let found = this.found.get(d)
      if (found?.query !== q) {
        found = { query: q, matches: findIn(block, this.view.plain(block, env), q, exact) }
        this.found.set(d, found)
      }
      for (const match of found.matches) {
        this.matches.push(match)
        let byLine = this.matchIndex.get(block)
        if (!byLine) {
          byLine = new Map()
          this.matchIndex.set(block, byLine)
        }
        for (const m of match) byLine.set(m.line, [...(byLine.get(m.line) ?? []), m])
      }
    }
    if (was) {
      const same = this.matches.findIndex(
        (m) => m[0]!.block === was.block && m[0]!.line === was.line && m[0]!.col === was.col,
      )
      if (same !== -1) this.current = same
    }
    if (this.current >= this.matches.length) this.current = this.matches.length - 1
  }

  /**
   * What the matches depend on besides the width: the blocks and their versions, and while a
   * block changes by itself (a reply streaming) the time, a few times a second.
   */
  private stamp(): string {
    let versions = 0
    let live = false
    for (const b of this.view.blocks) {
      versions += b.version
      live ||= b.live
    }
    return `${this.view.blocks.length}:${versions}:${live ? Math.floor(Date.now() / FIND_LIVE_MS) : ""}`
  }

  private jump(i: number): void {
    const env = this.view.env()
    const m = this.matches[i]?.[0]
    if (!env || !m) return
    this.current = i
    const gap = this.view.gapBefore(m.block.index, env) ? 1 : 0
    this.view.moveTo(m.block.index, gap + m.line - Math.floor(this.view.height() / 2))
  }
}

/** The matches of `q` in a block's rows `plain`, as `runFind` finds them. */
function findIn(block: Block, plain: readonly string[], q: string, exact: boolean): Match[][] {
  let text = ""
  /** The line and column of each character of `text`; -1 for what joins lines. */
  const lineOf: number[] = []
  const colOf: number[] = []
  for (let line = 0; line < plain.length; line++) {
    const raw = plain[line]!
    const start = raw.length - raw.trimStart().length
    const body = raw.slice(start).trimEnd()
    // Text wraps after a wide (CJK) character without dropping a space: those rows join as is.
    const joint = !text ? "" : !body ? "\n" : endsWide(text) ? "" : " "
    if (joint) {
      text += joint
      lineOf.push(-1)
      colOf.push(-1)
    }
    for (let k = 0; k < body.length; k++) {
      lineOf.push(line)
      colOf.push(start + k)
    }
    text += body
  }
  const lower = exact ? text : text.toLowerCase()
  const hay = lower.length === text.length ? lower : text
  const out: Match[][] = []
  let at = hay.indexOf(q)
  while (at !== -1) {
    const match: Match[] = []
    for (let k = at; k < at + q.length; k++) {
      const line = lineOf[k]!
      if (line < 0) continue
      const last = match[match.length - 1]
      if (last?.line === line) last.len = colOf[k]! + 1 - last.col
      else match.push({ block, line, col: colOf[k]!, len: 1 })
    }
    if (match.length) out.push(match)
    at = hay.indexOf(q, at + Math.max(1, q.length))
  }
  return out
}

/** Whether `text` ends with a wide (two-cell) character, after which text wraps without a space. */
function endsWide(text: string): boolean {
  const last = Array.from(text.slice(-2)).pop()
  return last !== undefined && visibleWidth(last) === 2
}

const MARK_ON = "\x1b[7m"
const CURRENT_ON = "\x1b[7;4m"
const MARK_OFF = "\x1b[27;24m"

/**
 * `line` with the given ranges of its plain text in inverse video (the current match also
 * underlined). Escape sequences are kept; one inside a range (a color change, a reset) is
 * followed by the mark again, so the range stays marked to its end.
 */
export function highlight(line: string, ranges: { col: number; len: number; current: boolean }[]): string {
  let out = ""
  let plain = 0
  let open: { end: number; on: string } | undefined
  const sorted = [...ranges].sort((a, b) => a.col - b.col)
  let next = 0
  for (let i = 0; i < line.length; ) {
    if (open && plain >= open.end) {
      out += MARK_OFF
      open = undefined
    }
    ESCAPE.lastIndex = i
    const esc = ESCAPE.exec(line)
    if (esc) {
      out += esc[0]
      if (open) out += open.on
      i += esc[0].length
      continue
    }
    while (!open && next < sorted.length && sorted[next]!.col + sorted[next]!.len <= plain) next++
    const r = sorted[next]
    if (!open && r && r.col <= plain) {
      open = { end: r.col + r.len, on: r.current ? CURRENT_ON : MARK_ON }
      out += open.on
      next++
    }
    out += line[i]
    plain++
    i++
  }
  if (open) out += MARK_OFF
  return out
}
