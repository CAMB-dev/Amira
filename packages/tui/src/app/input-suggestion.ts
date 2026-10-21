import type { Agent, UiRequests } from "@amira/core"
import { Editor, type EditorOptions, type InputEvent } from "@amira/tui-kit"
import { observeEditorState } from "../../../tui-kit/src/internal/editor-state.ts"
import { glyphs } from "../glyphs.ts"
import type { Keybindings } from "../keybindings.ts"
import { FOLD_PASTES } from "./startup.ts"

/** Local top-level session eligibility, including work not yet reflected in agent.busy. */
export function suggestionAgentBlocked(
  agent: Pick<Agent, "parentSessionId" | "depth" | "busy"> | undefined,
  activity: { working: boolean; compacting: boolean },
  quitting: boolean,
): boolean {
  return (
    !agent ||
    agent.parentSessionId !== undefined ||
    agent.depth !== 0 ||
    agent.busy ||
    activity.working ||
    activity.compacting ||
    quitting
  )
}

/** Local prompt only: dialogs, forms and remote frontends never receive this state. */
export function createPromptInput(deps: {
  ui?: UiRequests
  keys: Keybindings
  blocked: () => boolean
  onSubmit: NonNullable<EditorOptions["onSubmit"]>
  onFocus?: (focused: boolean) => void
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
  let focused: boolean | undefined
  let pastePending = false
  let revision = 0
  let attached = false
  let previous: readonly unknown[] = []
  const read = () => {
    const blocked = pastePending || focused === false || deps.blocked()
    const state = [editor.version, editor.focused, blocked]
    if (state.some((value, index) => value !== previous[index])) {
      revision++
      previous = state
    }
    return { revision, ready: editor.focused && editor.isEmpty && !blocked }
  }
  const refresh = () => {
    if (attached) source?.refresh()
  }
  const changed = () => {
    revision++
    refresh()
  }
  const visible = () =>
    !pastePending && focused !== false && editor.focused && editor.isEmpty && !deps.blocked()
      ? source?.text
      : undefined
  let disconnect = () => {}
  const attach = () => {
    if (!source) return () => {}
    attached = true
    const offEditor = observeEditorState(editor, changed)
    const detach = source.attach(read)
    return () => {
      attached = false
      offEditor()
      detach()
    }
  }
  return {
    editor,
    visible,
    changed,
    refresh,
    readerOptions: {
      onPasteState(pending: boolean) {
        pastePending = pending
        changed()
      },
    },
    handleFocus(e: InputEvent): boolean {
      if (e.type !== "focus") return false
      if (e.focused !== focused) {
        focused = e.focused
        changed()
        deps.onFocus?.(focused)
      }
      return true
    },
    after<T extends unknown[]>(handle: (...args: T) => void) {
      return (...args: T) => {
        try {
          handle(...args)
        } finally {
          refresh()
        }
      }
    },
    attach,
    /** Called only after every readiness dependency and lifecycle binding exists. */
    attachLocal(agent: Pick<Agent, "parentSessionId" | "depth"> | undefined) {
      if (agent && agent.parentSessionId === undefined && agent.depth === 0) disconnect = attach()
    },
    dispose: () => disconnect(),
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
