import { ANSI_PATTERN, RESET, stripAnsi } from "./ansi.ts"

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Display width in terminal cells, ignoring escape sequences. CJK and emoji count as 2. */
export function visibleWidth(s: string): number {
  return Bun.stringWidth(stripAnsi(s))
}

export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (seg) => seg.segment)
}

export interface Token {
  text: string
  width: number
  ansi: boolean
}

/** Splits a string into escape sequences and graphemes, keeping sequences intact. */
export function tokenize(s: string): Token[] {
  const out: Token[] = []
  const pushText = (t: string) => {
    for (const g of graphemes(t)) out.push({ text: g, width: Bun.stringWidth(g), ansi: false })
  }
  let last = 0
  for (const m of s.matchAll(ANSI_PATTERN)) {
    if (m.index > last) pushText(s.slice(last, m.index))
    out.push({ text: m[0], width: 0, ansi: true })
    last = m.index + m[0].length
  }
  if (last < s.length) pushText(s.slice(last))
  return out
}

/** Cuts a line to at most `width` cells without splitting graphemes or escape sequences. */
export function truncateToWidth(s: string, width: number, ellipsis = ""): string {
  if (visibleWidth(s) <= width) return s
  const ellWidth = visibleWidth(ellipsis)
  const limit = Math.max(0, width - ellWidth)
  let out = ""
  let used = 0
  let styled = false
  for (const t of tokenize(s)) {
    if (t.ansi) {
      out += t.text
      styled = true
      continue
    }
    if (used + t.width > limit) break
    out += t.text
    used += t.width
  }
  if (ellWidth > 0 && ellWidth <= width) out += ellipsis
  return styled ? out + RESET : out
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR sequences
const SGR = /^\x1b\[[0-9;:]*m$/

function isReset(seq: string): boolean {
  return seq === "\x1b[0m" || seq === "\x1b[m"
}

/**
 * Wraps text to `width` cells. Breaks at spaces when possible, after wide (CJK) characters,
 * and hard-breaks longer words. Styles are closed at each line end and re-opened on the next line.
 */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const raw: Token[][] = []
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) raw.push(...wrapParagraph(tokenize(para), w))
  return carryStyles(raw)
}

function wrapParagraph(tokens: Token[], width: number): Token[][] {
  const lines: Token[][] = []
  let line: Token[] = []
  let used = 0
  // Index in `line` where a break may happen, and whether the token there is a space to drop.
  let breakAt = -1
  let breakIsSpace = false

  for (const t of tokens) {
    if (t.ansi) {
      line.push(t)
      continue
    }
    if (t.text === "\t") {
      t.text = " "
      t.width = 1
    }
    const isSpace = t.text === " "
    if (used + t.width > width) {
      if (isSpace) {
        lines.push(line)
        line = []
        used = 0
        breakAt = -1
        continue
      }
      if (breakAt > 0) {
        const head = line.slice(0, breakAt)
        const tail = line.slice(breakIsSpace ? breakAt + 1 : breakAt)
        lines.push(head)
        line = tail
        used = tail.reduce((n, x) => n + x.width, 0)
      } else if (line.some((x) => !x.ansi)) {
        lines.push(line)
        line = []
        used = 0
      }
      breakAt = -1
    }
    line.push(t)
    used += t.width
    if (isSpace) {
      breakAt = line.length - 1
      breakIsSpace = true
    } else if (t.width === 2) {
      breakAt = line.length
      breakIsSpace = false
    }
  }
  lines.push(line)
  return lines
}

/** Which open codes each close code ends, so closed styles are not re-opened on the next line. */
const CLOSES: Record<string, (open: string) => boolean> = {
  "22": (o) => o === "1" || o === "2",
  "23": (o) => o === "3",
  "24": (o) => o === "4",
  "27": (o) => o === "7",
  "39": (o) => /^(3[0-8]|9[0-7])(;|$)/.test(o),
  "49": (o) => /^(4[0-8]|10[0-7])(;|$)/.test(o),
}

function applySgr(active: string[], seq: string): string[] {
  if (isReset(seq)) return []
  const params = seq.slice(2, -1)
  const closes = CLOSES[params]
  if (!closes) return [...active, seq]
  return active.filter((a) => !closes(a.slice(2, -1)))
}

function carryStyles(lines: Token[][]): string[] {
  let active: string[] = []
  return lines.map((tokens) => {
    let out = active.join("")
    for (const t of tokens) {
      out += t.text
      if (t.ansi && SGR.test(t.text)) active = applySgr(active, t.text)
    }
    return active.length > 0 ? out + RESET : out
  })
}
