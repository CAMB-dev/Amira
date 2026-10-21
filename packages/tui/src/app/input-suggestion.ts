import type { UiRequests } from "@amira/core"
import { Editor, type EditorOptions, type InputEvent } from "@amira/tui-kit"
import { glyphs } from "../glyphs.ts"
import type { Keybindings } from "../keybindings.ts"
import { FOLD_PASTES } from "./startup.ts"

/** Local prompt only: dialogs, forms and remote frontends never receive this state. */
export function createPromptInput(deps: {
  ui?: UiRequests
  keys: Keybindings
  blocked: () => boolean
  onSubmit: NonNullable<EditorOptions["onSubmit"]>
}) {
  const { keys } = deps
  const source = deps.ui?.inputSuggestions
  const editor = new Editor({
    prompt: `${glyphs.user} `,
    placeholder: "Message Amira",
    onSubmit: (text, info) => {
      source?.clear()
      deps.onSubmit(text, info)
    },
    foldPastes: FOLD_PASTES,
    isSubmit: (e) => keys.is(e, "submit"),
    isNewline: (e) => keys.is(e, "newline"),
  })
  const visible = () => (editor.focused && editor.isEmpty && !deps.blocked() ? source?.text : undefined)
  return {
    editor,
    visible,
    clear: () => source?.clear(),
    clearDraft() {
      source?.clear()
      editor.clear()
    },
    handleInput(e: InputEvent): boolean {
      // Literal, unmodified Tab only; Right and remapped popup keys do not accept ghost text.
      if (e.type === "key" && e.name === "tab" && !e.ctrl && !e.alt && !e.shift && visible()) {
        const text = source?.accept()
        if (text) editor.insert(text)
        return true
      }
      if (
        e.type === "paste" ||
        (e.type === "key" && e.text && !e.ctrl && !e.alt) ||
        keys.is(e, "paste.image") ||
        keys.is(e, "history.prev") ||
        keys.is(e, "history.next") ||
        keys.is(e, "history.search") ||
        (e.type === "key" && (e.name === "backspace" || e.name === "delete")) ||
        keys.is(e, "newline") ||
        keys.is(e, "edit.kill-to-start") ||
        keys.is(e, "edit.kill-to-end") ||
        keys.is(e, "edit.kill-word") ||
        keys.is(e, "edit.yank") ||
        keys.is(e, "edit.undo") ||
        keys.is(e, "edit.redo") ||
        keys.is(e, "edit.external") ||
        keys.is(e, "submit") ||
        keys.is(e, "queue") ||
        keys.is(e, "submit.steer") ||
        keys.is(e, "submit.queue")
      )
        source?.clear()
      return false
    },
  }
}
