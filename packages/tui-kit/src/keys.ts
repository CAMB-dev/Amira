type FunctionKeyNumber =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25
  | 26
  | 27
  | 28
  | 29
  | 30
  | 31
  | 32
  | 33
  | 34
  | 35

/** Names of keys that are not a single character. */
export type KeyName =
  | "enter"
  | "tab"
  | "escape"
  | "backspace"
  | "delete"
  | "insert"
  | "space"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "begin"
  | `f${FunctionKeyNumber}`
  | "capslock"
  | "scrolllock"
  | "numlock"
  | "printscreen"
  | "pause"
  | "menu"
  | "media_play"
  | "media_pause"
  | "media_play_pause"
  | "media_reverse"
  | "media_stop"
  | "media_fast_forward"
  | "media_rewind"
  | "media_track_next"
  | "media_track_previous"
  | "media_record"
  | "volume_down"
  | "volume_up"
  | "volume_mute"

/** A key name, or a single lower-cased character. `string & {}` keeps editor completion for `KeyName`. */
export type KeyId = KeyName | (string & {})

/**
 * A key press. `name` is a key name ("enter", "up", "f5", "space", ...) or, for printable
 * keys, the lowercased character. `text` is set only when the key should insert text.
 */
export interface KeyEvent {
  type: "key"
  name: KeyId
  ctrl: boolean
  shift: boolean
  alt: boolean
  text?: string
}

export interface PasteEvent {
  type: "paste"
  text: string
}

/** The terminal window gained or lost focus; only sent while focus reporting (mode 1004) is on. */
export interface FocusEvent {
  type: "focus"
  focused: boolean
}

export type InputEvent = KeyEvent | PasteEvent | FocusEvent

export function key(name: KeyId, mods: Partial<Pick<KeyEvent, "ctrl" | "shift" | "alt">> = {}): KeyEvent {
  return { type: "key", name, ctrl: !!mods.ctrl, shift: !!mods.shift, alt: !!mods.alt }
}

export function textKey(
  text: string,
  mods: Partial<Pick<KeyEvent, "ctrl" | "shift" | "alt">> = {},
): KeyEvent {
  const name = text === " " ? "space" : text.toLowerCase()
  return { ...key(name, mods), text }
}

/**
 * True for the "insert a newline" key: Shift+Enter, or Ctrl+Enter, which is the fallback on
 * terminals that cannot report Shift with Enter.
 */
export function isNewlineKey(e: InputEvent): boolean {
  return e.type === "key" && e.name === "enter" && !e.alt && (e.shift || e.ctrl)
}

/** True for plain Enter. */
export function isSubmitKey(e: InputEvent): boolean {
  return e.type === "key" && e.name === "enter" && !e.shift && !e.ctrl && !e.alt
}

export function matchesKey(
  e: InputEvent,
  name: KeyId,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
) {
  return (
    e.type === "key" &&
    e.name === name &&
    e.ctrl === !!mods.ctrl &&
    e.alt === !!mods.alt &&
    (mods.shift === undefined || e.shift === mods.shift)
  )
}
