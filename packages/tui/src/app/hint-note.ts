import { HINT_NOTE_MS } from "./startup.ts"

/** A short note shown in place of the key hints, such as the new tool output level. */
export function createHintNote(requestRender: () => void) {
  let note: { text: string; until: number } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    current: () => note,
    show(text: string) {
      note = { text, until: Date.now() + HINT_NOTE_MS }
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
