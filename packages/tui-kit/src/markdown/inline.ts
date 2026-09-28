import { compose, type MarkdownToken, markdownTheme, type StyleFn, type Theme } from "../style.ts"

export type MarkdownStyles = Record<MarkdownToken, StyleFn>

/** The Markdown tokens of a theme, with `markdownTheme` filling in the ones it lacks. */
export function markdownStyles(theme: Theme): MarkdownStyles {
  const out = {} as MarkdownStyles
  for (const k of Object.keys(markdownTheme) as MarkdownToken[]) out[k] = theme[k] ?? markdownTheme[k]
  return out
}

/** A piece of rendered text in one style. */
export interface Run {
  text: string
  style?: StyleFn
  /** Target of an OSC 8 hyperlink around the text. */
  link?: string
  /** Offset of `text` in the parsed source; the text is the source there, character for character. */
  src: number
  /**
   * Opening delimiters of the spans around the run (`**`, `` ` ``, `[`), outermost first. Parsing
   * `carry + source.slice(at)` for an offset inside the run renders the rest of the text the same.
   */
  carry: string
  /** False when parsing from inside the run would not render the rest the same (URLs, added text). */
  cuttable: boolean
}

export interface InlineOptions {
  styles: MarkdownStyles
  /** Make links clickable with OSC 8; otherwise their URL follows the text. */
  hyperlinks: boolean
  /** Style of the text around the spans, e.g. a heading's. */
  base?: StyleFn
}

const PUNCT = /[!-/:-@[-`{-~]/
const SPACE = /\s/
const WORD = /[\p{L}\p{N}]/u
/** Characters a bare URL does not end with, since they usually belong to the sentence. */
const URL_TAIL = /[.,;:!?'")\]}*_]+$/
const BARE_URL = /https?:\/\/[^\s<>`]+/y
const AUTOLINK = /<(https?:\/\/[^\s<>]+)>/y

interface Scope {
  styles: StyleFn[]
  carry: string
  link?: string
}

/**
 * Renders inline Markdown: `code`, **strong**, *emphasis*, ~~strike~~, [links](url), <autolinks>,
 * bare URLs and backslash escapes. A delimiter without a match is shown as it is, so text that is
 * still streaming renders as plain until its span closes.
 */
export function parseInline(s: string, opts: InlineOptions): Run[] {
  const out: Run[] = []
  parse(s, 0, s.length, { styles: opts.base ? [opts.base] : [], carry: "" }, opts, out)
  return out
}

function styleOf(styles: StyleFn[]): StyleFn | undefined {
  if (styles.length === 0) return undefined
  if (styles.length === 1) return styles[0]
  return compose(...styles)
}

function parse(s: string, start: number, end: number, scope: Scope, opts: InlineOptions, out: Run[]) {
  const style = styleOf(scope.styles)
  let textStart = start
  const flush = (to: number) => {
    if (to > textStart) out.push(run(s.slice(textStart, to), textStart, style, scope, true))
  }
  let i = start
  while (i < end) {
    const c = s[i]!
    if (c === "\\" && i + 1 < end && PUNCT.test(s[i + 1]!)) {
      flush(i)
      out.push(run(s[i + 1]!, i + 1, style, scope, true))
      i += 2
      textStart = i
      continue
    }
    if (c === "`") {
      const n = runLength(s, i, end, "`")
      const close = findTicks(s, i + n, end, n)
      if (close === -1) {
        i += n
        continue
      }
      flush(i)
      let from = i + n
      let to = close
      const inner = s.slice(from, to)
      if (inner.length > 1 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "") {
        from++
        to--
      }
      if (to > from) {
        const codeScope = { ...scope, carry: scope.carry + "`".repeat(n) }
        out.push(run(s.slice(from, to), from, styleOf([...scope.styles, opts.styles.code]), codeScope, true))
      }
      i = close + n
      textStart = i
      continue
    }
    if (c === "[" && !scope.link) {
      const link = matchLink(s, i, end)
      if (link) {
        flush(i)
        const linkStyles = [...scope.styles, opts.styles.link]
        const inner: Scope = { styles: linkStyles, carry: `${scope.carry}[` }
        if (opts.hyperlinks) inner.link = link.url
        if (link.textEnd > i + 1) parse(s, i + 1, link.textEnd, inner, opts, out)
        const text = s.slice(i + 1, link.textEnd)
        if (!opts.hyperlinks && text !== link.url) {
          const url = styleOf([...scope.styles, opts.styles.linkUrl])
          out.push(run(` (${link.url})`, link.end, url, scope, false))
        }
        i = link.end
        textStart = i
        continue
      }
    }
    if (c === "<" && !scope.link) {
      AUTOLINK.lastIndex = i
      const m = AUTOLINK.exec(s)
      if (m && i + m[0].length <= end) {
        flush(i)
        pushUrl(m[1]!, i + 1, scope, opts, out)
        i += m[0].length
        textStart = i
        continue
      }
    }
    if (c === "h" && !scope.link && (i === 0 || !WORD.test(s[i - 1]!))) {
      BARE_URL.lastIndex = i
      const m = BARE_URL.exec(s)
      if (m) {
        const url = m[0].slice(0, Math.min(m[0].length, end - i)).replace(URL_TAIL, "")
        if (url.length > "https://".length) {
          flush(i)
          pushUrl(url, i, scope, opts, out)
          i += url.length
          textStart = i
          continue
        }
      }
    }
    if (c === "*" || c === "_" || (c === "~" && s[i + 1] === "~")) {
      const n = runLength(s, i, end, c)
      const span = matchEmphasis(s, i, n, end, c)
      if (span) {
        flush(i)
        const styles = [...scope.styles, ...spanStyles(c, span.len, opts)]
        const delim = c.repeat(span.len)
        parse(s, i + span.len, span.close, { ...scope, styles, carry: scope.carry + delim }, opts, out)
        i = span.close + span.len
        textStart = i
        continue
      }
      i += n
      continue
    }
    i++
  }
  flush(end)
}

function run(text: string, src: number, style: StyleFn | undefined, scope: Scope, cuttable: boolean): Run {
  const r: Run = { text, src, carry: scope.carry, cuttable }
  if (style) r.style = style
  if (scope.link) r.link = scope.link
  return r
}

function pushUrl(url: string, src: number, scope: Scope, opts: InlineOptions, out: Run[]) {
  const r = run(url, src, styleOf([...scope.styles, opts.styles.link]), scope, false)
  if (opts.hyperlinks) r.link = url
  out.push(r)
}

function spanStyles(c: string, len: number, opts: InlineOptions): StyleFn[] {
  if (c === "~") return [opts.styles.strike]
  if (len === 3) return [opts.styles.strong, opts.styles.emphasis]
  return [len === 2 ? opts.styles.strong : opts.styles.emphasis]
}

function runLength(s: string, i: number, end: number, c: string): number {
  let j = i
  while (j < end && s[j] === c) j++
  return j - i
}

/** The start of the next run of exactly `n` backticks in `s[from, end)`, or -1. */
function findTicks(s: string, from: number, end: number, n: number): number {
  let j = from
  while (j < end) {
    const k = s.indexOf("`", j)
    if (k === -1 || k >= end) return -1
    const len = runLength(s, k, end, "`")
    if (len === n) return k
    j = k + len
  }
  return -1
}

/**
 * An emphasis span opening at `s[i]` with a run of `n` delimiters `c`: its delimiter length and
 * where its closing run starts. The opener must be followed by a non-space and the closer preceded
 * by one; `_` must also not touch a letter on the outside (`snake_case_name` stays as it is).
 */
function matchEmphasis(
  s: string,
  i: number,
  n: number,
  end: number,
  c: string,
): { len: number; close: number } | undefined {
  const after = s[i + n]
  if (after === undefined || i + n >= end || SPACE.test(after)) return undefined
  if (c === "_" && i > 0 && WORD.test(s[i - 1]!)) return undefined
  const lens = c === "~" ? (n === 2 ? [2] : []) : n >= 3 ? [3, 2, 1] : n === 2 ? [2, 1] : [1]
  for (const len of lens) {
    let j = i + len
    while (j < end) {
      const k = s.indexOf(c, j)
      if (k === -1 || k >= end) break
      const runLen = runLength(s, k, end, c)
      const fits = len === 3 ? runLen >= 3 : runLen === len
      const before = s[k - 1]!
      const outside = s[k + len]
      if (
        fits &&
        k > i + len &&
        !SPACE.test(before) &&
        (c !== "_" || outside === undefined || !WORD.test(outside))
      ) {
        return { len, close: k }
      }
      j = k + runLen
    }
  }
  return undefined
}

/** `[text](url)` or `[text](url "title")` at `s[i]`: where its text ends, its URL, and its end. */
function matchLink(
  s: string,
  i: number,
  end: number,
): { textEnd: number; url: string; end: number } | undefined {
  let depth = 0
  let j = i
  for (; j < end; j++) {
    const ch = s[j]
    if (ch === "\\") j++
    else if (ch === "[") depth++
    else if (ch === "]" && --depth === 0) break
  }
  if (j >= end || s[j + 1] !== "(") return undefined
  const close = s.indexOf(")", j + 2)
  if (close === -1 || close >= end) return undefined
  const target = s.slice(j + 2, close).trim()
  const url = target.split(/\s+/)[0] ?? ""
  if (url === "" || /[<>]/.test(url)) return undefined
  return { textEnd: j, url: url.replace(/^<|>$/g, ""), end: close + 1 }
}
