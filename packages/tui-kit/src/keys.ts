/**
 * A key press. `name` is a key name ("enter", "up", "f5", "space", ...) or, for printable
 * keys, the lowercased character. `text` is set only when the key should insert text.
 */
export interface KeyEvent {
  type: "key"
  name: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  text?: string
}

export interface PasteEvent {
  type: "paste"
  text: string
}

export type InputEvent = KeyEvent | PasteEvent

export function key(name: string, mods: Partial<Pick<KeyEvent, "ctrl" | "shift" | "alt">> = {}): KeyEvent {
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
  name: string,
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
