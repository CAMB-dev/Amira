import { HINT_NOTE_MS } from "./startup.ts"

/**
 * A short note shown in place of the key hints, such as the new tool output level. A `key`
 * it names is drawn bold, as in the key hints.
 */
export function createHintNote(requestRender: () => void) {
  let note: { text: string; until: number; key?: string } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    current: () => note,
    show(text: string, key?: string) {
      note = { text, until: Date.now() + HINT_NOTE_MS, ...(key ? { key } : {}) }
      clearTimeout(timer)
      timer = setTimeout(requestRender, HINT_NOTE_MS + 10)
      requestRender()
    },
    /** Clears the note only while it still shows this text. */
    clear(text: string) {
      if (note?.text !== text) return
      note = undefined
      clearTimeout(timer)
      requestRender()
    },
    dispose: () => clearTimeout(timer),
  }
}
