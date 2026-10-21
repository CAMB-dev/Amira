import type { Editor, EditorPart } from "../components/editor.ts"

type Restore = (parts: EditorPart[], placeholder?: string) => void

// Constructors register closures so native focus can reset private editing state without
// exposing another Editor method or retaining editors after their owners are disposed.
const restorers = new WeakMap<Editor, Restore>()
const observers = new WeakMap<Editor, Set<() => void>>()
const focus = new WeakMap<Editor, boolean>()

/** Focus uses the same private observer seam as content changes. */
export function editorFocus(editor: Editor, focused?: boolean): boolean {
  const previous = focus.get(editor) ?? true
  if (focused !== undefined && focused !== previous) {
    focus.set(editor, focused)
    editorStateChanged(editor)
  }
  return focused ?? previous
}

/** Internal composer seam: all content and focus changes, without exposing draft text. */
export function observeEditorState(editor: Editor, changed: () => void): () => void {
  let listeners = observers.get(editor)
  if (!listeners) {
    listeners = new Set()
    observers.set(editor, listeners)
  }
  listeners.add(changed)
  return () => listeners.delete(changed)
}

export function editorStateChanged(editor: Editor): void {
  for (const changed of observers.get(editor) ?? []) changed()
}

export function registerEditorState(editor: Editor, restore: Restore): void {
  restorers.set(editor, restore)
}

/** Internal native-focus boundary: restore a draft, forgetting the previous scope's buffers. */
export function restoreEditorState(editor: Editor, parts: EditorPart[], placeholder?: string): void {
  const restore = restorers.get(editor)
  if (!restore) throw new Error("Editor state restorer was not registered")
  restore(parts, placeholder)
}
