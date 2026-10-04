import { visibleWidth } from "../width.ts"

/** Editor content: text, a folded paste, or an image kept as one placeholder. */
export type EditorPart = string | { paste: string } | { image: EditorImage }

export interface EditorImage {
  name: string
  mimeType: string
  data: string
}

export function imageLabel(image: EditorImage, n: number): string {
  const bytes =
    Math.floor((image.data.length * 3) / 4) -
    (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0)
  const size = bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KB`
  return `[image ${n}: ${image.name.replace(/\p{Cc}/gu, " ")} ${size}]`
}

/** What a folded paste's placeholder says. */
export interface PasteInfo {
  /** Lines of the pasted text (a trailing line break does not start another). */
  lines: number
  chars: number
  /** Numbers the editor's placeholders from 1; restarts when the editor is emptied. */
  n: number
}

/** "[pasted 2000 lines #1]", or "[pasted 1500 chars #1]" for a single long line. */
export function defaultPasteLabel({ lines, chars, n }: PasteInfo): string {
  return lines > 1 ? `[pasted ${lines} lines #${n}]` : `[pasted ${chars} chars #${n}]`
}

interface Paste {
  text: string
  part: Exclude<EditorPart, string>
  label: string
  width: number
}

export interface PasteSnapshot {
  pastes: Map<string, Paste>
  nextPaste: number
  nextImage: number
  nextToken: number
}

/**
 * Folded pastes are stored in the text as one code point each from Supplementary Private Use
 * Area-B, which fonts (Nerd Fonts included) leave unused, so a grapheme is a whole placeholder.
 */
const TOKEN_BASE = 0x100000
const TOKEN_LAST = 0x10fffd
const TOKEN_PATTERN = /[\u{100000}-\u{10fffd}]/gu
const TOKEN_TEST = /[\u{100000}-\u{10fffd}]/u

/** Folded paste/image payloads and their placeholder tokens, independent of the editor's caret and lines. */
export class EditorPastes {
  private pastes = new Map<string, Paste>()
  private nextPaste = 1
  private nextImage = 1
  private nextToken = TOKEN_BASE

  constructor(
    private opts: { foldPastes?: { lines: number; chars: number }; pasteLabel?: (info: PasteInfo) => string },
  ) {}

  get size(): number {
    return this.pastes.size
  }

  get(token: string): Paste | undefined {
    return this.pastes.get(token)
  }

  hasTokens(text: string): boolean {
    return TOKEN_TEST.test(text)
  }

  /** Forgets the pastes whose placeholders lie in text about to be deleted. */
  drop(text: string): void {
    for (const m of text.matchAll(TOKEN_PATTERN)) this.pastes.delete(m[0])
  }

  snapshot(): PasteSnapshot {
    return {
      pastes: new Map(this.pastes),
      nextPaste: this.nextPaste,
      nextImage: this.nextImage,
      nextToken: this.nextToken,
    }
  }

  restore(s: PasteSnapshot): void {
    this.pastes = new Map(s.pastes)
    this.nextPaste = s.nextPaste
    this.nextImage = s.nextImage
    this.nextToken = s.nextToken
  }

  parts(joined: string): EditorPart[] {
    if (!this.pastes.size) return joined ? [joined] : []
    const parts: EditorPart[] = []
    let last = 0
    for (const m of joined.matchAll(TOKEN_PATTERN)) {
      const paste = this.pastes.get(m[0])
      if (!paste) continue
      if (m.index > last) parts.push(joined.slice(last, m.index))
      parts.push(paste.part)
      last = m.index + m[0].length
    }
    if (last < joined.length) parts.push(joined.slice(last))
    return parts
  }

  shouldFold(text: string): boolean {
    const fold = this.opts.foldPastes
    if (!fold) return false
    return text.length >= fold.chars || lineCount(normalize(text)) >= fold.lines
  }

  /** Registers a folded paste and returns the character that stands for it. */
  addPaste(text: string): string {
    return this.addPart({ paste: text })
  }

  addPart(part: Exclude<EditorPart, string>): string {
    let cp = this.nextToken
    // Skip characters still in use once the range wraps around (only after 1M placeholders).
    while (this.pastes.has(String.fromCodePoint(cp))) cp = cp >= TOKEN_LAST ? TOKEN_BASE : cp + 1
    this.nextToken = cp >= TOKEN_LAST ? TOKEN_BASE : cp + 1
    const token = String.fromCodePoint(cp)
    const text = "paste" in part ? normalize(part.paste) : ""
    const label =
      "image" in part
        ? imageLabel(part.image, this.nextImage++)
        : (this.opts.pasteLabel ?? defaultPasteLabel)({
            lines: lineCount(text),
            chars: text.length,
            n: this.nextPaste++,
          })
    this.pastes.set(token, {
      text,
      part: "paste" in part ? { paste: text } : part,
      label,
      width: visibleWidth(label),
    })
    return token
  }

  reset(): void {
    this.pastes.clear()
    this.nextPaste = 1
    this.nextImage = 1
    this.nextToken = TOKEN_BASE
  }

  /** Replaces the placeholders in `s`. */
  expand(s: string, as: (p: Paste) => string): string {
    return s.replace(TOKEN_PATTERN, (t) => {
      const p = this.pastes.get(t)
      return p ? as(p) : t
    })
  }
}

export function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

/** `text` with placeholder-range characters replaced by U+FFFD (see `insert`). */
export function escapeTokens(text: string): string {
  return TOKEN_TEST.test(text) ? text.replace(TOKEN_PATTERN, "�") : text
}

/** Lines of `text`; a trailing line break does not start another. */
function lineCount(text: string): number {
  let n = 1
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++
  return text.endsWith("\n") ? n - 1 : n
}
