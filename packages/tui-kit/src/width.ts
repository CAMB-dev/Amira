import { ANSI_PATTERN, RESET, stripAnsi } from "./ansi.ts"
import { CURSOR_MARKER } from "./component.ts"
import { sgrAttributes, sgrGroup } from "./style.ts"

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Tabs are expanded to spaces up to the next multiple of this many columns. */
export const TAB_WIDTH = 4

/** Escape sequences that are safe to send to the terminal: SGR styles and OSC 8 hyperlinks. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const SAFE_SEQUENCE = /^(?:\x1b\[[0-9;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters
const UNSAFE = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/

/** Display width in terminal cells, ignoring escape sequences. CJK and emoji count as 2. */
export function visibleWidth(s: string): number {
  return textWidth(stripAnsi(sanitize(s)))
}

/**
 * Symbols with an emoji form that stay text, one cell, when nothing asks for the emoji form.
 * Every other character with the Emoji property but no emoji presentation of its own (✉ ☑ ⚠ ❤
 * ☀ ✏ ✔ ...) counts as two cells and is drawn as the emoji (see `presentEmoji`): Windows
 * Terminal, and often VS Code, take those from the emoji font whenever the terminal font lacks
 * them, two cells wide over a one-cell slot, so the next character is drawn over.
 *
 * The ones kept here are in Cascadia Mono (Windows Terminal's font) and so drawn from it, one
 * cell: the keycap bases # * 0-9, © ® ™ ‼, the arrows ↔ ↕, the shapes ▪ ▫ ◻ ◼ ▶ ◀, and
 * ☺ ♀ ♂ ♠ ♣ ♥ ♦. All but ▶ ◀ ◻ ◼ are in Consolas (VS Code's default font on Windows) too.
 * Cascadia Mono lacks the other arrows (↖ ↗ ↘ ↙ ↩ ↪ ⤴ ⤵ ➡ ⬅ ⬆ ⬇), ⁉, ℹ and Ⓜ, so those
 * count as emoji. A character followed by VS15 (U+FE0E) or VS16 (U+FE0F) is measured as it asks:
 * one cell for text, two for emoji.
 */
const TEXT_SYMBOLS = "#*0123456789©®™‼↔↕▪▫◻◼▶◀☺♀♂♠♣♥♦"

/** A character that counts as an emoji although it has no emoji presentation of its own. */
const TEXT_EMOJI = new RegExp(`[\\p{Emoji}--\\p{Emoji_Presentation}--[${TEXT_SYMBOLS}]]`, "v")
const TEXT_EMOJI_START = new RegExp(`^${TEXT_EMOJI.source}`, "v")
const VS15 = "\uFE0E"
const VS16 = "\uFE0F"

/** A grapheme drawn as an emoji although it does not ask for it: its width goes from 1 to 2. */
function isBareEmoji(g: string): boolean {
  return TEXT_EMOJI_START.test(g) && !g.includes(VS15) && !g.includes(VS16) && Bun.stringWidth(g) === 1
}

/**
 * Width in cells of text without escape sequences: `Bun.stringWidth`, except that a character
 * with an emoji form that is not in `TEXT_SYMBOLS` counts as two cells unless VS15 follows it.
 */
export function textWidth(s: string): number {
  const w = Bun.stringWidth(s)
  if (!TEXT_EMOJI.test(s)) return w
  let extra = 0
  for (const g of graphemes(s)) if (isBareEmoji(g)) extra++
  return w + extra
}

/**
 * Asks for the emoji form (VS16) after each character `textWidth` counts as an emoji although
 * nothing asked for it, so the terminal draws it two cells wide, as it was measured; the width
 * stays the same. Escape sequences are left alone. For the renderers' final write only: what
 * is copied or searched is the text as it came.
 */
export function presentEmoji(s: string): string {
  if (!TEXT_EMOJI.test(s)) return s
  let out = ""
  let last = 0
  const text = (t: string) => {
    for (const g of graphemes(t)) {
      if (!isBareEmoji(g)) {
        out += g
        continue
      }
      const first = String.fromCodePoint(g.codePointAt(0)!)
      out += first + VS16 + g.slice(first.length)
    }
  }
  for (const m of s.matchAll(ANSI_PATTERN)) {
    if (m.index > last) text(s.slice(last, m.index))
    out += m[0]
    last = m.index + m[0].length
  }
  if (last < s.length) text(s.slice(last))
  return out
}

/** Splits a string into user-perceived characters (grapheme clusters). */
export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (seg) => seg.segment)
}

export interface Token {
  text: string
  width: number
  ansi: boolean
}

/**
 * Splits a string into escape sequences and graphemes, and makes it safe to print: only SGR,
 * OSC 8 and the cursor marker survive, other escapes and control characters (except `\n`) are
 * dropped, and tabs become spaces, so that content can never move the cursor or erase anything.
 */
export function tokenize(s: string): Token[] {
  const out: Token[] = []
  let col = 0
  const pushText = (t: string) => {
    for (const g of graphemes(t)) {
      if (g === "\t") {
        const n = TAB_WIDTH - (col % TAB_WIDTH)
        for (let i = 0; i < n; i++) out.push({ text: " ", width: 1, ansi: false })
        col += n
        continue
      }
      const text = g.replace(CONTROLS, "")
      if (text === "") continue
      const width = textWidth(text)
      out.push({ text, width, ansi: false })
      col = text === "\n" ? 0 : col + width
    }
  }
  let last = 0
  for (const m of s.matchAll(ANSI_PATTERN)) {
    if (m.index > last) pushText(s.slice(last, m.index))
    if (isSafeSequence(m[0])) out.push({ text: m[0], width: 0, ansi: true })
    last = m.index + m[0].length
  }
  if (last < s.length) pushText(s.slice(last))
  return out
}

/** Drops everything `tokenize` drops and expands tabs; returns `s` itself when it is already safe. */
export function sanitize(s: string): string {
  if (isSafe(s)) return s
  return tokenize(s)
    .map((t) => t.text)
    .join("")
}

function isSafeSequence(seq: string): boolean {
  return SAFE_SEQUENCE.test(seq) || seq === CURSOR_MARKER
}

function isSafe(s: string): boolean {
  if (!UNSAFE.test(s)) return true
  if (!s.includes("\x1b")) return false
  for (const m of s.matchAll(ANSI_PATTERN)) if (!isSafeSequence(m[0])) return false
  return !UNSAFE.test(s.replace(ANSI_PATTERN, ""))
}

/** Cuts a line to at most `width` cells without splitting graphemes or escape sequences. */
export function truncateToWidth(s: string, width: number, ellipsis = ""): string {
  const line = sanitize(s).replaceAll("\n", "")
  if (visibleWidth(line) <= width) return line
  const ellWidth = visibleWidth(ellipsis)
  const limit = Math.max(0, width - ellWidth)
  let out = ""
  let used = 0
  let styled = false
  let link: string | undefined
  for (const t of tokenize(line)) {
    if (t.ansi) {
      out += t.text
      styled ||= SGR.test(t.text)
      link = applyLink(link, t.text)
      continue
    }
    if (used + t.width > limit) break
    out += t.text
    used += t.width
  }
  if (ellWidth > 0 && ellWidth <= width) out += ellipsis
  if (link) out += LINK_CLOSE
  return styled ? out + RESET : out
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR sequences
const SGR = /^\x1b\[[0-9;:]*m$/

/**
 * Wraps text to `width` cells. Breaks at spaces when possible, after wide (CJK) characters,
 * and hard-breaks longer words. Styles are closed at each line end and re-opened on the next line.
 */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const raw: Token[][] = []
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    // Pushed one by one: spreading a huge paragraph's rows as arguments overflows the stack.
    for (const row of wrapParagraph(tokenize(para), w)) raw.push(row)
  }
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
    const isSpace = t.text === " "
    if (used + t.width > width) {
      if (isSpace) {
        lines.push(line)
        line = []
        used = 0
        breakAt = -1
        continue
      }
      // Break only when the head has text; a head of bare escapes would be a blank line.
      if (breakAt > 0 && line.slice(0, breakAt).some((x) => !x.ansi)) {
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

const CLOSES: Record<string, string[]> = {
  "22": ["1", "2"],
  "23": ["3"],
  "24": ["4", "21"],
  "4:0": ["4", "21"],
  "25": ["5", "6"],
  "27": ["7"],
  "28": ["8"],
  "29": ["9"],
  "39": ["fg"],
  "49": ["bg"],
  "55": ["53"],
  "59": ["ul"],
}

/** Applies an SGR sequence to the list of active attributes. */
function applySgr(active: string[], seq: string): string[] {
  let next = active
  for (const attr of sgrAttributes(seq.slice(2, -1))) {
    if (Number.parseInt(attr, 10) === 0) {
      next = []
      continue
    }
    const closes = CLOSES[attr] ?? CLOSES[String(Number.parseInt(attr, 10))]
    if (closes) {
      next = next.filter((a) => !closes.includes(sgrGroup(a)))
      continue
    }
    const group = sgrGroup(attr)
    next = [...next.filter((a) => sgrGroup(a) !== group), attr]
  }
  return next
}

const LINK_CLOSE = "\x1b]8;;\x07"
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching OSC 8 hyperlinks
const LINK = /^\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)/

/** Tracks the open hyperlink: returns the opening sequence, or undefined once it is closed. */
function applyLink(open: string | undefined, seq: string): string | undefined {
  const m = seq.match(LINK)
  if (!m) return open
  return m[1] ? seq : undefined
}

/** Ends a line so that no style or hyperlink it opened bleeds into the cells after it. */
export function closeStyles(line: string): string {
  if (!line.includes("\x1b")) return line
  let link: string | undefined
  for (const m of line.matchAll(ANSI_PATTERN)) link = applyLink(link, m[0])
  const out = link ? line + LINK_CLOSE : line
  return out.endsWith(RESET) ? out : out + RESET
}

function carryStyles(lines: Token[][]): string[] {
  let active: string[] = []
  let link: string | undefined
  return lines.map((tokens) => {
    let out = (active.length > 0 ? `\x1b[${active.join(";")}m` : "") + (link ?? "")
    for (const t of tokens) {
      out += t.text
      if (!t.ansi) continue
      if (SGR.test(t.text)) active = applySgr(active, t.text)
      else link = applyLink(link, t.text)
    }
    if (link) out += LINK_CLOSE
    return active.length > 0 ? out + RESET : out
  })
}
