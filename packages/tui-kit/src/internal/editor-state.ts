import type { Editor, EditorPart } from "../components/editor.ts"

type Restore = (parts: EditorPart[], placeholder?: string) => void

// Constructors register closures so native focus can reset private editing state without
// exposing another Editor method or retaining editors after their owners are disposed.
const restorers = new WeakMap<Editor, Restore>()

export function registerEditorState(editor: Editor, restore: Restore): void {
  restorers.set(editor, restore)
}

/** Internal native-focus boundary: restore a draft, forgetting the previous scope's buffers. */
export function restoreEditorState(editor: Editor, parts: EditorPart[], placeholder?: string): void {
  const restore = restorers.get(editor)
  if (!restore) throw new Error("Editor state restorer was not registered")
  restore(parts, placeholder)
}
