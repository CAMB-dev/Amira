import { type InputEvent, type KeyEvent, key, textKey } from "./keys.ts"

const ESC = "\x1b"
const PASTE_END = "\x1b[201~"

type Mods = { ctrl: boolean; shift: boolean; alt: boolean }
const NO_MODS: Mods = { ctrl: false, shift: false, alt: false }

interface Parsed {
  len: number
  events?: KeyEvent[]
  pasteStart?: boolean
}

const LETTER_FINALS: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
}

const TILDE_CODES: Record<number, string> = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
}

const KITTY_CODES: Record<number, string> = { 9: "tab", 13: "enter", 27: "escape", 127: "backspace" }

const VK_NAMES: Record<number, string> = {
  8: "backspace",
  9: "tab",
  13: "enter",
  27: "escape",
  32: "space",
  33: "pageup",
  34: "pagedown",
  35: "end",
  36: "home",
  37: "left",
  38: "up",
  39: "right",
  40: "down",
  45: "insert",
  46: "delete",
}
for (let i = 0; i < 12; i++) VK_NAMES[112 + i] = `f${i + 1}`

/** Shift, Ctrl, Alt, CapsLock, Windows keys, NumLock, ScrollLock: never emitted on their own. */
const VK_MODIFIERS = new Set([16, 17, 18, 20, 91, 92, 93, 144, 145])

/** xterm-style modifier parameter: 1 + (shift | alt << 1 | ctrl << 2). */
function xtermMods(param: string | undefined): Mods {
  const m = Math.max(0, (Number.parseInt(param ?? "1", 10) || 1) - 1)
  return { shift: (m & 1) !== 0, alt: (m & 2) !== 0, ctrl: (m & 4) !== 0 }
}

function withMods(e: KeyEvent, mods: Partial<Mods>): KeyEvent {
  return { ...e, ctrl: e.ctrl || !!mods.ctrl, shift: e.shift || !!mods.shift, alt: e.alt || !!mods.alt }
}

/** A printable character with modifiers: Ctrl/Alt combos are shortcuts and carry no text. */
function charKey(ch: string, mods: Mods): KeyEvent {
  if (mods.ctrl || mods.alt) return key(ch === " " ? "space" : ch.toLowerCase(), mods)
  return textKey(ch, { shift: mods.shift })
}

function controlKey(ch: string): KeyEvent | undefined {
  const c = ch.charCodeAt(0)
  if (ch === "\r") return key("enter")
  if (ch === "\n") return key("enter", { ctrl: true })
  if (ch === "\t") return key("tab")
  if (ch === "\x7f" || ch === "\x08") return key("backspace")
  if (c === 0) return key("space", { ctrl: true })
  if (c >= 1 && c <= 26) return key(String.fromCharCode(c + 96), { ctrl: true })
  if (c >= 28 && c <= 31) return key(String.fromCharCode(c + 64), { ctrl: true })
  return undefined
}

type Decoded = Omit<Parsed, "len">

function decodeWin32(params: string): Decoded {
  const [vk = 0, , uc = 0, kd = 0, cs = 0, rc = 1] = params.split(";").map((p) => Number.parseInt(p, 10) || 0)
  if (kd !== 1) return {}
  const repeat = Math.max(1, rc)
  if (VK_MODIFIERS.has(vk)) return {}
  const ctrl = (cs & 0x0c) !== 0
  const alt = (cs & 0x03) !== 0
  const shift = (cs & 0x10) !== 0
  // AltGr is reported as Ctrl+Alt; when it produced a character, that character is plain text.
  const altGr = ctrl && alt && uc >= 32
  const mods: Mods = altGr ? { ctrl: false, alt: false, shift } : { ctrl, alt, shift }
  let e: KeyEvent | undefined
  const named = VK_NAMES[vk]
  if (named === "space") e = charKey(" ", mods)
  else if (named) e = key(named, mods)
  else if (uc >= 32) e = charKey(String.fromCharCode(uc), mods)
  else if (ctrl && ((vk >= 65 && vk <= 90) || (vk >= 48 && vk <= 57)))
    e = key(String.fromCharCode(vk).toLowerCase(), mods)
  return { events: e ? Array.from({ length: repeat }, () => e) : [] }
}

function decodeKitty(params: string): KeyEvent[] {
  const [codePart = "", modPart = ""] = params.split(";")
  const code = Number.parseInt(codePart.split(":")[0] ?? "", 10)
  const [modStr, eventType] = modPart.split(":")
  if (eventType === "3" || Number.isNaN(code)) return []
  const mods = xtermMods(modStr)
  const named = KITTY_CODES[code]
  if (named) return [key(named, mods)]
  return [charKey(String.fromCodePoint(code), mods)]
}

function decodeCsi(params: string, final: string): Decoded {
  if (params.startsWith("?")) return {} // replies to capability queries
  if (final === "_") return decodeWin32(params)
  if (final === "u") return { events: decodeKitty(params) }
  const parts = params.split(";")
  if (final === "~") {
    const code = Number.parseInt(parts[0] ?? "", 10)
    if (code === 200) return { pasteStart: true }
    const name = TILDE_CODES[code]
    return { events: name ? [key(name, xtermMods(parts[1]))] : [] }
  }
  if (final === "Z") return { events: [key("tab", { shift: true })] }
  const name = LETTER_FINALS[final]
  return { events: name ? [key(name, xtermMods(parts[1]))] : [] }
}

function parseEscape(s: string, force: boolean): Parsed | undefined {
  if (s.length === 1) return force ? { len: 1, events: [key("escape")] } : undefined
  const second = s[1]!
  if (second === "[") {
    let i = 2
    while (i < s.length && s.charCodeAt(i) >= 0x20 && s.charCodeAt(i) <= 0x3f) i++
    if (i >= s.length) return force ? { len: 1, events: [key("escape")] } : undefined
    return { len: i + 1, ...decodeCsi(s.slice(2, i), s[i]!) }
  }
  if (second === "O") {
    if (s.length < 3) return force ? { len: 1, events: [key("escape")] } : undefined
    const name = LETTER_FINALS[s[2]!]
    return { len: 3, events: name ? [key(name)] : [] }
  }
  // ESC followed by a key is Alt+key.
  const inner = parseOne(s.slice(1), force)
  if (!inner) return force ? { len: 1, events: [key("escape")] } : undefined
  if (!inner.events) return { len: 1, events: [key("escape")] }
  const events = inner.events.map((e) => {
    const { text: _, ...rest } = e
    return withMods(rest, { alt: true })
  })
  return { len: inner.len + 1, events }
}

function parseOne(s: string, force: boolean): Parsed | undefined {
  const ch = s[0]!
  if (ch === ESC) return parseEscape(s, force)
  const control = controlKey(ch)
  if (control) return { len: 1, events: [control] }
  const cp = s.codePointAt(0)!
  const char = String.fromCodePoint(cp)
  return { len: char.length, events: [charKey(char, NO_MODS)] }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const WIN32_SEQ = /\x1b\[([\d;]*)_/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const WIN32_PREFIX = /\x1b(?:\[[\d;]*)?$/

function partialSuffix(s: string, marker: string): number {
  for (let n = Math.min(marker.length - 1, s.length); n > 0; n--) {
    if (marker.startsWith(s.slice(s.length - n))) return n
  }
  return 0
}

function isHigh(s: string | undefined): boolean {
  const c = s?.length === 1 ? s.charCodeAt(0) : 0
  return c >= 0xd800 && c <= 0xdbff
}

function isLow(s: string | undefined): boolean {
  const c = s?.length === 1 ? s.charCodeAt(0) : 0
  return c >= 0xdc00 && c <= 0xdfff
}

/**
 * Turns raw terminal input into key and paste events. Pure: it does no I/O and keeps no timers.
 * Handles legacy VT sequences, the kitty keyboard protocol, win32-input-mode and bracketed paste,
 * with input split anywhere across chunks. A lone ESC stays pending until more input arrives or
 * `flush()` is called (after a short timeout, see `InputReader`).
 */
export class InputParser {
  private buf = ""
  private held = ""
  private paste: string | undefined
  private high = ""

  feed(data: string): InputEvent[] {
    this.buf += this.unwrapRawWin32(data)
    return this.drain(false)
  }

  /** True when an ambiguous escape prefix is waiting; call `flush()` if nothing follows soon. */
  get pending(): boolean {
    return this.paste === undefined && (this.buf.length > 0 || this.held.length > 0)
  }

  flush(): InputEvent[] {
    this.buf += this.held
    this.held = ""
    return this.drain(true)
  }

  /**
   * win32-input-mode events with vk=0 carry raw characters (IME text, and replies or pastes the
   * terminal forwards character by character). They are replaced by those characters before
   * parsing, so that sequences spelled out one event at a time are parsed like any other input.
   */
  private unwrapRawWin32(data: string): string {
    let s = this.held + data
    const tail = s.match(WIN32_PREFIX)
    this.held = tail ? tail[0] : ""
    if (tail) s = s.slice(0, s.length - this.held.length)
    return s.replace(WIN32_SEQ, (seq, params: string) => {
      const [vk = 0, , uc = 0, kd = 0, , rc = 1] = params.split(";").map((p) => Number.parseInt(p, 10) || 0)
      if (vk !== 0) return seq
      return kd === 1 && uc > 0 ? String.fromCharCode(uc).repeat(Math.max(1, rc)) : ""
    })
  }

  private drain(force: boolean): InputEvent[] {
    const out: InputEvent[] = []
    while (this.buf.length > 0) {
      if (this.paste !== undefined) {
        const end = this.buf.indexOf(PASTE_END)
        if (end === -1) {
          const keep = partialSuffix(this.buf, PASTE_END)
          this.paste += this.buf.slice(0, this.buf.length - keep)
          this.buf = this.buf.slice(this.buf.length - keep)
          break
        }
        const text = (this.paste + this.buf.slice(0, end)).replace(/\r\n?/g, "\n")
        this.buf = this.buf.slice(end + PASTE_END.length)
        this.paste = undefined
        out.push({ type: "paste", text })
        continue
      }
      const parsed = parseOne(this.buf, force)
      if (!parsed) break
      this.buf = this.buf.slice(parsed.len)
      if (parsed.pasteStart) this.paste = ""
      for (const e of parsed.events ?? []) this.emit(e, out)
    }
    return out
  }

  /** Joins surrogate halves that arrive as separate events (win32-input-mode sends UTF-16 units). */
  private emit(e: KeyEvent, out: InputEvent[]): void {
    if (isHigh(e.text)) {
      this.high = e.text!
      return
    }
    if (isLow(e.text)) {
      if (this.high) out.push(textKey(this.high + e.text!, { shift: e.shift }))
      this.high = ""
      return
    }
    this.high = ""
    out.push(e)
  }
}
