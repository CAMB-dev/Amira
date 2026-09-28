import { type InputEvent, type KeyEvent, type KeyName, key, type PasteEvent, textKey } from "./keys.ts"

const ESC = "\x1b"
const PASTE_END = "\x1b[201~"

type Mods = { ctrl: boolean; shift: boolean; alt: boolean }
const NO_MODS: Mods = { ctrl: false, shift: false, alt: false }

interface Parsed {
  len: number
  events?: KeyEvent[]
  pasteStart?: boolean
  /** A focus report: CSI I (gained) or CSI O (lost). */
  focus?: boolean
}

const LETTER_FINALS: Record<string, KeyName> = {
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

const TILDE_CODES: Record<number, KeyName> = {
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

const KITTY_CODES: Record<number, KeyName> = {
  9: "tab",
  13: "enter",
  27: "escape",
  127: "backspace",
  57358: "capslock",
  57359: "scrolllock",
  57360: "numlock",
  57361: "printscreen",
  57362: "pause",
  57363: "menu",
  57414: "enter",
  57417: "left",
  57418: "right",
  57419: "up",
  57420: "down",
  57421: "pageup",
  57422: "pagedown",
  57423: "home",
  57424: "end",
  57425: "insert",
  57426: "delete",
  57427: "begin",
  57428: "media_play",
  57429: "media_pause",
  57430: "media_play_pause",
  57431: "media_reverse",
  57432: "media_stop",
  57433: "media_fast_forward",
  57434: "media_rewind",
  57435: "media_track_next",
  57436: "media_track_previous",
  57437: "media_record",
  57438: "volume_down",
  57439: "volume_up",
  57440: "volume_mute",
}
for (let i = 0; i < 23; i++) KITTY_CODES[57376 + i] = `f${i + 13}` as KeyName

/** Keypad keys that type a character. */
const KITTY_KEYPAD_TEXT: Record<number, string> = {
  57409: ".",
  57410: "/",
  57411: "*",
  57412: "-",
  57413: "+",
  57415: "=",
  57416: ",",
}
for (let i = 0; i < 10; i++) KITTY_KEYPAD_TEXT[57399 + i] = String(i)

/** Kitty reports functional keys (keypad, media, modifiers, ...) as private-use code points. */
function isPrivateUse(code: number): boolean {
  return code >= 0xe000 && code <= 0xf8ff
}

const VK_NAMES: Record<number, KeyName> = {
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
for (let i = 0; i < 12; i++) VK_NAMES[112 + i] = `f${i + 1}` as KeyName

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
  if (c >= 27 && c <= 31) return key(String.fromCharCode(c + 64), { ctrl: true })
  return undefined
}

type Decoded = Omit<Parsed, "len">

/** win32-input-mode parameters: Vk, Sc, Uc, Kd, Cs, Rc. */
function win32Params(params: string): [vk: number, uc: number, kd: number, cs: number, rc: number] {
  const [vk = 0, , uc = 0, kd = 0, cs = 0, rc = 1] = params.split(";").map((p) => Number.parseInt(p, 10) || 0)
  return [vk, uc, kd, cs, rc]
}

function decodeWin32(params: string): Decoded {
  const [vk, uc, kd, cs, rc] = win32Params(params)
  // A character typed with Alt+numpad arrives on the key-up of Alt.
  if (kd === 0 && vk === 18 && uc > 0) return { events: [textKey(String.fromCharCode(uc))] }
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
  else if (ctrl && uc > 0 && uc < 32) {
    // Ctrl+punctuation (Ctrl+[ is 27, Ctrl+] is 29, ...) only shows up as a control character.
    const control = controlKey(String.fromCharCode(uc))
    if (control) e = withMods(control, mods)
  }
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
  const keypad = KITTY_KEYPAD_TEXT[code]
  if (keypad) return [charKey(keypad, mods)]
  // Unknown functional keys (modifier keys on their own, ...) and invalid code points.
  if (isPrivateUse(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return []
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
  if (params === "" && (final === "I" || final === "O")) return { focus: final === "I" }
  const name = LETTER_FINALS[final]
  return { events: name ? [key(name, xtermMods(parts[1]))] : [] }
}

/**
 * What to do with input that may be the start of a longer sequence: wait for more, resolve it as
 * keys because nothing more came, or also drop a sequence that was cut short.
 */
type Flush = "wait" | "resolve" | "drop"

const escapeKey = (len = 1): Parsed => ({ len, events: [key("escape")] })

/** A CSI or SS3 sequence starting at `s[at]`, or undefined when it is not complete yet. */
function parseSequence(s: string, at: number): Parsed | undefined {
  if (s[at + 1] === "O") {
    if (s.length < at + 3) return undefined
    const name = LETTER_FINALS[s[at + 2]!]
    return { len: 3, events: name ? [key(name)] : [] }
  }
  let i = at + 2
  while (i < s.length && s.charCodeAt(i) >= 0x20 && s.charCodeAt(i) <= 0x3f) i++
  if (i >= s.length) return undefined
  // A control character (ESC starting the next sequence, say) aborts a sequence cut short: the
  // partial is dropped and the control character is left for the next parse.
  if (s.charCodeAt(i) < 0x20) return { len: i - at, events: [] }
  return { len: i + 1 - at, ...decodeCsi(s.slice(at + 2, i), s[i]!) }
}

function startsSequence(s: string, at: number): boolean {
  return s[at] === ESC && (s[at + 1] === "[" || s[at + 1] === "O")
}

/** A key pressed with Alt carries no text; an upper-case letter means Shift was held. */
function altKey(e: KeyEvent): KeyEvent {
  const { text, ...rest } = e
  return withMods(rest, { alt: true, shift: text !== undefined && text !== text.toLowerCase() })
}

function parseKey(s: string, at: number): Parsed {
  const control = controlKey(s[at]!)
  if (control) return { len: 1, events: [control] }
  const char = String.fromCodePoint(s.codePointAt(at)!)
  return { len: char.length, events: [charKey(char, NO_MODS)] }
}

/** Parses the input at the start of `s`, which begins with ESC. Never recurses. */
function parseEscape(s: string, flush: Flush): Parsed | undefined {
  const second = s[1]
  if (second === undefined) return flush === "wait" ? undefined : escapeKey()
  if (second === "[" || second === "O") {
    const seq = parseSequence(s, 0)
    if (seq) return seq
    if (flush === "wait") return undefined
    // Alt+[ and Alt+Shift+O are indistinguishable from the start of a sequence until it times out.
    if (s.length === 2) {
      return {
        len: 2,
        events: [second === "[" ? key("[", { alt: true }) : key("o", { alt: true, shift: true })],
      }
    }
    // A sequence cut short (say, a late reply to a query) is never typed out as text.
    return flush === "drop" ? { len: s.length, events: [] } : undefined
  }
  if (second === ESC) {
    // ESC ESC [A is Alt+Up; ESC ESC otherwise is Esc pressed twice.
    if (startsSequence(s, 1)) {
      const seq = parseSequence(s, 1)
      if (seq?.events?.length) return { len: seq.len + 1, events: seq.events.map(altKey) }
      if (!seq && flush === "wait") return undefined
      return escapeKey()
    }
    if (s.length === 2 && flush === "wait") return undefined
    return escapeKey()
  }
  // ESC followed by a key is Alt+key.
  const inner = parseKey(s, 1)
  return { len: inner.len + 1, events: inner.events!.map(altKey) }
}

function parseOne(s: string, flush: Flush): Parsed | undefined {
  return s[0] === ESC ? parseEscape(s, flush) : parseKey(s, 0)
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const WIN32_SEQ = /\x1b\[([\d;]*)_/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const WIN32_PREFIX = /\x1b(?:\[[\d;]*)?$/

/** Pastes are handed over in pieces of at most about this many characters (4 MiB). */
const MAX_PASTE = 4 * 1024 * 1024

function pasteEvent(text: string): PasteEvent {
  return { type: "paste", text: text.replace(/\r\n?/g, "\n") }
}

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
  private win32 = false

  feed(data: string): InputEvent[] {
    this.buf += this.unwrapRawWin32(data)
    return this.drain("wait")
  }

  /** True when an ambiguous escape prefix is waiting; call `flush()` if nothing follows soon. */
  get pending(): boolean {
    return this.paste === undefined && (this.buf.length > 0 || this.held.length > 0)
  }

  /** True inside a bracketed paste; call `endPaste()` if its end marker never comes. */
  get pasting(): boolean {
    return this.paste !== undefined
  }

  /** Ends a paste whose end marker never came, emitting what was collected. */
  endPaste(): InputEvent[] {
    if (this.paste === undefined) return []
    const text = this.paste
    this.paste = undefined
    this.buf = ""
    this.held = ""
    return text === "" ? [] : [pasteEvent(text)]
  }

  /**
   * Resolves input that was waiting for more: a lone ESC is the Esc key, ESC [ is Alt+[, and so
   * on. A sequence cut short (ESC [ with parameters) stays pending, since its end may still come;
   * `flush(true)` drops it.
   */
  flush(drop = false): InputEvent[] {
    this.buf += this.held
    this.held = ""
    return this.drain(drop ? "drop" : "resolve")
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
      this.win32 = true
      const [vk, uc, kd, , rc] = win32Params(params)
      if (vk !== 0) return seq
      return kd === 1 && uc > 0 ? String.fromCharCode(uc).repeat(Math.max(1, rc)) : ""
    })
  }

  private drain(flush: Flush): InputEvent[] {
    const out: InputEvent[] = []
    while (this.buf.length > 0) {
      if (this.paste !== undefined) {
        const end = this.buf.indexOf(PASTE_END)
        if (end === -1) {
          const keep = partialSuffix(this.buf, PASTE_END)
          this.paste += this.pasteText(this.buf.slice(0, this.buf.length - keep))
          this.buf = this.buf.slice(this.buf.length - keep)
          // Hand over a huge paste in pieces rather than holding it all.
          if (this.paste.length >= MAX_PASTE) {
            out.push(pasteEvent(this.paste))
            this.paste = ""
          }
          break
        }
        const text = this.paste + this.pasteText(this.buf.slice(0, end))
        this.buf = this.buf.slice(end + PASTE_END.length)
        this.paste = undefined
        if (text !== "") out.push(pasteEvent(text))
        continue
      }
      const parsed = parseOne(this.buf, flush)
      if (!parsed) break
      this.buf = this.buf.slice(parsed.len)
      if (parsed.pasteStart) this.paste = ""
      if (parsed.focus !== undefined) out.push({ type: "focus", focused: parsed.focus })
      for (const e of parsed.events ?? []) this.emit(e, out)
    }
    return out
  }

  /**
   * In win32-input-mode the paste body can arrive as real key events (vk != 0) between markers
   * sent as vk=0 characters. Those events are turned back into the characters they typed.
   */
  private pasteText(s: string): string {
    if (!this.win32) return s
    return s.replace(WIN32_SEQ, (_, params: string) => {
      const [vk, uc, kd, , rc] = win32Params(params)
      if (kd !== 1 || uc === 0) return ""
      // Enter is "\r" so that Enter followed by a raw "\n" normalizes to a single line break.
      return (vk === 13 ? "\r" : String.fromCharCode(uc)).repeat(Math.max(1, rc))
    })
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
