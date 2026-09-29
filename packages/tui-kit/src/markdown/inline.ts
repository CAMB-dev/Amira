import { defaultGlyphs } from "../glyphs.ts"
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
  /**
   * How the rest of a run that is not cuttable goes on after a cut inside it, as a `Lead`: the
   * rest of a bare URL (`head`: the URL before the run) is found in the source again; other text
   * is shown as it is, the source going on at offset `resume`.
   */
  rest?: { url: true; head: string } | { url: false; resume: number }
  /** The run stands for an image (`![alt](url)`), shown as its alt text. */
  image?: ImageRef
}

/** An image in the text: where it points (unknown for a reference not defined yet) and its alt text. */
export interface ImageRef {
  url?: string
  alt: string
}

/** A reference definition (`[label]: url`), looked up by its normalized label. */
export interface LinkRef {
  url: string
}

/** How reference labels are matched: case and runs of blanks do not matter. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase()
}

/**
 * The rest of a run that a cut went through (a URL too long for the live region), placed right
 * after the carried delimiters and drawn as the run was.
 */
export type Lead =
  | { url: true; head: string; style?: StyleFn }
  | { url: false; parts: LeadPart[]; len: number }

/**
 * Added text drawn after a cut: the rest of the run the cut went through, then the runs of added
 * text that stand at the same place in the source (an image's URL after its alt text), which
 * parsing the source from there would not bring back.
 */
export interface LeadPart {
  text: string
  style?: StyleFn
  link?: string
}

export interface InlineOptions {
  styles: MarkdownStyles
  /** Make links clickable with OSC 8; otherwise their URL follows the text. */
  hyperlinks: boolean
  /** Style of the text around the spans, e.g. a heading's. */
  base?: StyleFn
  /** Reference definitions seen so far, for `[text][label]` and `![alt][label]`. */
  refs?: ReadonlyMap<string, LinkRef>
  /** Drawn in front of an image's alt text. Default: the glyphs' `image`. */
  imageGlyph?: string
  /** A run's rest at offset `leadAt`: for a bare URL, the source there; otherwise `len` source characters. */
  lead?: Lead
  leadAt?: number
}

/** Runs, and where the first delimiter that may still open a span once more text comes is. */
export interface Parsed {
  runs: Run[]
  /** Offset of that delimiter, or Infinity: rows after it may still change. */
  open: number
}

interface Context {
  opts: InlineOptions
  out: Run[]
  lead?: Lead
  leadAt: number
  open: number
  /** The whole text's length: only a delimiter scanned to it may still match. */
  length: number
}

const PUNCT = /[!-/:-@[-`{-~]/
const SPACE = /\s/
const WORD = /[\p{L}\p{N}]/u
/** Characters a bare URL does not end with, since they usually belong to the sentence. */
const URL_TAIL = /[.,;:!?'")\]}*_]+$/
const BARE_URL = /https?:\/\/[^\s<>`]+/y
/** What goes on with a bare URL after its start. */
const URL_REST = /[^\s<>`]*/y
const AUTOLINK = /<(https?:\/\/[^\s<>]+)>/y

interface Scope {
  styles: StyleFn[]
  carry: string
  link?: string
  /** Inside a link's text, clickable or not. */
  inLink?: boolean
}

/**
 * Renders inline Markdown: `code`, **strong**, *emphasis*, ~~strike~~, [links](url), <autolinks>,
 * bare URLs, backslash escapes, `[text][label]` references to definitions seen so far, and images
 * (`![alt](url)`, `![alt][label]`), shown as a glyph and their alt text (or file name) linking to
 * the image, or followed by its URL when links are not clickable. A delimiter without a match is shown as it is, so text that is
 * still streaming renders as plain until its span closes.
 */
export function parseInline(s: string, opts: InlineOptions): Run[] {
  return parseLine(s, opts).runs
}

/** `parseInline`, and where the text may still change as more of it streams in. */
export function parseLine(s: string, opts: InlineOptions): Parsed {
  const ctx: Context = {
    opts,
    out: [],
    leadAt: opts.leadAt ?? 0,
    open: Number.POSITIVE_INFINITY,
    length: s.length,
  }
  if (opts.lead) ctx.lead = opts.lead
  parse(s, 0, s.length, { styles: opts.base ? [opts.base] : [], carry: "" }, ctx)
  return { runs: ctx.out, open: ctx.open }
}

function styleOf(styles: StyleFn[]): StyleFn | undefined {
  if (styles.length === 0) return undefined
  if (styles.length === 1) return styles[0]
  return compose(...styles)
}

function parse(s: string, start: number, end: number, scope: Scope, ctx: Context) {
  const { opts, out } = ctx
  const style = styleOf(scope.styles)
  let textStart = start
  const flush = (to: number) => {
    if (to > textStart) out.push(run(s.slice(textStart, to), textStart, style, scope, true))
  }
  /** A delimiter at `at` has no match yet; one may come if the text goes on. */
  const mayOpen = (at: number) => {
    if (end === ctx.length) ctx.open = Math.min(ctx.open, at)
  }
  let i = start
  while (i < end) {
    if (ctx.lead && i >= ctx.leadAt) {
      // Past it inside a span that cannot hold it: the rest is parsed as it is.
      if (i > ctx.leadAt) ctx.lead = undefined
      else {
        flush(i)
        i = pushLead(s, i, end, scope, ctx)
        textStart = i
        continue
      }
    }
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
        mayOpen(i)
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
    if (c === "!" && s[i + 1] === "[") {
      const image = matchLink(s, i + 1, end, opts.refs, true)
      if (image === "open") {
        mayOpen(i)
        i++
        continue
      }
      if (image) {
        flush(i)
        if (image.open) mayOpen(i)
        pushImage(s, i, image, scope, ctx)
        i = image.end
        textStart = i
        continue
      }
    }
    if (c === "[" && !scope.link && !scope.inLink) {
      const link = matchLink(s, i, end, opts.refs)
      if (link === "open") mayOpen(i)
      else if (link?.url !== undefined) {
        flush(i)
        if (link.open) mayOpen(i)
        const linkStyles = [...scope.styles, opts.styles.link]
        const inner: Scope = { styles: linkStyles, carry: `${scope.carry}[`, inLink: true }
        if (opts.hyperlinks) inner.link = link.url
        if (link.textEnd > i + 1 || ctx.lead) parse(s, i + 1, link.textEnd, inner, ctx)
        const text = s.slice(i + 1, link.textEnd)
        if (!opts.hyperlinks && text !== link.url) {
          const url = styleOf([...scope.styles, opts.styles.linkUrl])
          const r = run(` (${link.url})`, link.end, url, scope, false)
          r.rest = { url: false, resume: link.end }
          out.push(r)
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
        pushUrl(m[1]!, i + 1, scope, opts, out).rest = { url: false, resume: i + m[0].length }
        i += m[0].length
        textStart = i
        continue
      }
      if (/^<[^\s<>]*$/.test(s.slice(i, end))) mayOpen(i)
    }
    if (c === "h" && !scope.link && (i === 0 || !WORD.test(s[i - 1]!))) {
      BARE_URL.lastIndex = i
      const m = BARE_URL.exec(s)
      if (m) {
        const url = m[0].slice(0, Math.min(m[0].length, end - i)).replace(URL_TAIL, "")
        if (url.length > "https://".length) {
          flush(i)
          pushUrl(url, i, scope, opts, out).rest = { url: true, head: "" }
          i += url.length
          textStart = i
          continue
        }
      }
    }
    if (c === "*" || c === "_" || (c === "~" && s[i + 1] === "~")) {
      const n = runLength(s, i, end, c)
      const span = matchEmphasis(s, i, n, end, c)
      if (span === "open") mayOpen(i)
      else if (span) {
        flush(i)
        const styles = [...scope.styles, ...spanStyles(c, span.len, opts)]
        const delim = c.repeat(span.len)
        parse(s, i + span.len, span.close, { ...scope, styles, carry: scope.carry + delim }, ctx)
        i = span.close + span.len
        textStart = i
        continue
      }
      i += n
      continue
    }
    i++
  }
  // The rest of an image cut at the end of a link's text is still that text.
  if (ctx.lead && !ctx.lead.url && ctx.leadAt === end && i === end) {
    flush(end)
    textStart = pushLead(s, end, end, scope, ctx)
  }
  flush(end)
}

function run(text: string, src: number, style: StyleFn | undefined, scope: Scope, cuttable: boolean): Run {
  const r: Run = { text, src, carry: scope.carry, cuttable }
  if (style) r.style = style
  if (scope.link) r.link = scope.link
  return r
}

function pushUrl(url: string, src: number, scope: Scope, opts: InlineOptions, out: Run[]): Run {
  const r = run(url, src, styleOf([...scope.styles, opts.styles.link]), scope, false)
  if (opts.hyperlinks) r.link = url
  out.push(r)
  return r
}

/** Draws the lead at `i`, in the spans open there, and returns where the source goes on. */
function pushLead(s: string, i: number, end: number, scope: Scope, ctx: Context): number {
  const lead = ctx.lead!
  ctx.lead = undefined
  if (lead.url) {
    URL_REST.lastIndex = i
    const text = URL_REST.exec(s)![0]
      .slice(0, end - i)
      .replace(URL_TAIL, "")
    if (text === "") return i
    const r: Run = { text, src: i, carry: scope.carry, cuttable: false, rest: { url: true, head: lead.head } }
    if (ctx.opts.hyperlinks) r.link = lead.head + text
    if (lead.style) r.style = lead.style
    ctx.out.push(r)
    return i + text.length
  }
  const next = Math.min(end, i + lead.len)
  for (const part of lead.parts) {
    if (!part.text) continue
    const r: Run = {
      text: part.text,
      src: i,
      carry: scope.carry,
      cuttable: false,
      rest: { url: false, resume: next },
    }
    if (part.link) r.link = part.link
    if (part.style) r.style = part.style
    ctx.out.push(r)
  }
  return next
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
 * `"open"` when it may still open a span that closes after `end`.
 */
function matchEmphasis(
  s: string,
  i: number,
  n: number,
  end: number,
  c: string,
): { len: number; close: number } | "open" | undefined {
  if (c === "_" && i > 0 && WORD.test(s[i - 1]!)) return undefined
  const lens = c === "~" ? (n === 2 ? [2] : []) : n >= 3 ? [3, 2, 1] : n === 2 ? [2, 1] : [1]
  if (lens.length === 0) return undefined
  const after = s[i + n]
  if (after === undefined || i + n >= end) return "open"
  if (SPACE.test(after)) return undefined
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
  return "open"
}

interface LinkMatch {
  textEnd: number
  /** Unknown only for an image referring to a label not defined (yet). */
  url?: string
  end: number
  /** It may still turn into something else as the text goes on (`[label]` at the end). */
  open?: boolean
}

/**
 * `[text](url)`, `[text](url "title")`, `[text][label]`, `[text][]` or `[label]` (the last three
 * with a definition in `refs`) at `s[i]`: where its text ends, its URL, and its end. For an
 * `image`, a `[label]` not defined still matches, without a URL. `"open"` when it may still be
 * one once the text goes on after `end`.
 */
function matchLink(
  s: string,
  i: number,
  end: number,
  refs?: ReadonlyMap<string, LinkRef>,
  image = false,
): LinkMatch | "open" | undefined {
  let depth = 0
  let j = i
  for (; j < end; j++) {
    const ch = s[j]
    if (ch === "\\") j++
    else if (ch === "[") depth++
    else if (ch === "]" && --depth === 0) break
  }
  if (j >= end) return "open"
  const after = s[j + 1]
  const text = s.slice(i + 1, j)
  if (after === "(") {
    const close = s.indexOf(")", j + 2)
    if (close === -1 || close >= end) return "open"
    const target = s.slice(j + 2, close).trim()
    const url = target.split(/\s+/)[0] ?? ""
    if (url === "" || /[<>]/.test(url)) return undefined
    return { textEnd: j, url: url.replace(/^<|>$/g, ""), end: close + 1 }
  }
  if (after === "[") {
    const close = s.indexOf("]", j + 2)
    if (close === -1 || close >= end) return "open"
    const label = s.slice(j + 2, close)
    if (label.includes("[")) return undefined
    const ref = refs?.get(normalizeLabel(label || text))
    if (ref) return { textEnd: j, url: ref.url, end: close + 1 }
    return image ? { textEnd: j, end: close + 1 } : undefined
  }
  const ref = text.trim() ? refs?.get(normalizeLabel(text)) : undefined
  if (ref) return { textEnd: j, url: ref.url, end: j + 1, ...(j + 1 >= end ? { open: true } : {}) }
  return j + 1 >= end ? "open" : undefined
}

/** The last segment of a URL's path, as the name of an image without alt text. */
export function fileName(url: string | undefined): string {
  if (!url) return ""
  const path = url.split(/[?#]/)[0]!.replace(/[/\\]+$/, "")
  const last = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1)
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/**
 * An image at `s[i]`: its glyph and alt text (or file name), linking to the image when links
 * are clickable (inside a link, to that link), or followed by its URL.
 */
function pushImage(s: string, i: number, image: LinkMatch, scope: Scope, ctx: Context) {
  const { opts, out } = ctx
  const alt = s
    .slice(i + 2, image.textEnd)
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .trim()
  const name = alt || fileName(image.url) || "image"
  const clickable = !scope.inLink && opts.hyperlinks && image.url !== undefined
  const style = styleOf([...scope.styles, clickable ? opts.styles.link : opts.styles.image])
  // Added text, like a link's URL: it stands at the image's end, so the rest of it after a cut
  // goes on there.
  const r: Run = {
    text: `${opts.imageGlyph ?? defaultGlyphs.image} ${name}`,
    src: image.end,
    carry: scope.carry,
    cuttable: false,
    rest: { url: false, resume: image.end },
    image: image.url !== undefined ? { url: image.url, alt } : { alt },
  }
  if (style) r.style = style
  const link = scope.link ?? (clickable ? image.url : undefined)
  if (link) r.link = link
  out.push(r)
  // Inside a link too: a link still open may close around it, and the rows stay the same then.
  if (!opts.hyperlinks && image.url !== undefined) {
    const u = run(` (${image.url})`, image.end, styleOf([...scope.styles, opts.styles.linkUrl]), scope, false)
    u.rest = { url: false, resume: image.end }
    out.push(u)
  }
}
