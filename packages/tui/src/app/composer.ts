// Owns pre-submit editing, completion lists, prompt history, clipboard and external editing.
import { spawnSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Agent, CommandHost } from "@amira/core"
import type { Editor, EditorImage, InputEvent, Terminal } from "@amira/tui-kit"
import { CommandPopup } from "../command-popup.ts"
import { FileIndex, type FileSource } from "../file-index.ts"
import { FilePicker } from "../file-picker.ts"
import { HistorySearch, type SearchAction } from "../history-search.ts"
import {
  type ClipboardContent,
  imageBytes,
  imageMimeType,
  MAX_IMAGE_BYTES,
  pastedImagePaths,
  readClipboard,
  readImage,
} from "../image-input.ts"
import type { Keybindings } from "../keybindings.ts"
import { HistoryNavigator, type PromptHistory } from "../prompt-history.ts"
import { externalEditor } from "./external-editor.ts"

export interface ComposerDeps {
  editor: Editor
  keys: Keybindings
  history: PromptHistory
  commands?: Pick<CommandHost, "complete" | "list" | "completeSkill" | "skills" | "inputLine">
  files?: FileSource
  /** Returns the current agent itself: clipboard results also check its identity. */
  agent: () => Pick<Agent, "cwd">
  env: Record<string, string | undefined>
  terminal: Pick<Terminal, "suspend">
  clipboard?: (cwd: string, signal: AbortSignal) => Promise<ClipboardContent>
  showNote: (text: string) => void
  requestRender: () => void
  redraw: () => void
  redrawTerminal: () => void
  runPopup: (line: string) => void
}

export interface Composer {
  readonly search: HistorySearch
  readonly popups: CommandPopup[]
  readonly filePicker: FilePicker
  readonly clipboardPending: boolean
  cancelClipboard(): void
  abortClipboard(): void
  dispose(): void
  resetHistory(): void
  syncCompletions(): Promise<void> | undefined
  /** Refreshes lists before routing, when no dialog has the keyboard. */
  prepareInput(e: InputEvent): void
  handleSearchKey(e: InputEvent): SearchAction
  handleCompletionKey(e: InputEvent): boolean
  /** Paste and history keys, after the transcript has had its chance. */
  handleInput(e: InputEvent): boolean
  editKey(e: InputEvent): boolean
  handleEditorInput(e: InputEvent): void
}

/** Pre-submit editing and lists; the app keeps submission and input routing. */
export function createComposer(deps: ComposerDeps): Composer {
  const { editor, keys, history, commands, env, terminal, showNote, redraw } = deps
  const clipboardAbort = new AbortController()
  let clipboardRead: AbortController | undefined

  function cancelClipboard() {
    clipboardRead?.abort()
    clipboardRead = undefined
  }

  function attachImages(attachments: EditorImage[]): boolean {
    const bytes = imageBytes([...editor.getParts(), ...attachments.map((image) => ({ image }))])
    if (bytes > MAX_IMAGE_BYTES) {
      showNote("Images in a message are limited to 5 MB total. Remove an attachment or resize it first.")
      return false
    }
    for (const image of attachments) editor.insertImage(image)
    showNote(
      `Attached ${attachments.map((image) => image.name.replace(/\p{Cc}/gu, " ")).join(", ")}. Backspace removes an attachment.`,
    )
    return true
  }

  function pasteText(text: string) {
    const paths = pastedImagePaths(text, deps.agent().cwd)
    let images: EditorImage[] | undefined
    try {
      images = paths?.map(readImage)
    } catch (err) {
      // An image that cannot be attached stays a path in the text rather than vanishing.
      showNote(`${err instanceof Error ? err.message : String(err)} Pasted as text.`)
    }
    if (!images || !attachImages(images)) editor.handleInput({ type: "paste", text })
    redraw()
  }

  async function pasteClipboard() {
    if (clipboardRead) return
    const read = new AbortController()
    clipboardRead = read
    const signal = AbortSignal.any([clipboardAbort.signal, read.signal])
    const session = deps.agent()
    try {
      const result = await (deps.clipboard
        ? deps.clipboard(deps.agent().cwd, signal)
        : readClipboard({ cwd: deps.agent().cwd, env: { ...process.env, ...env }, signal }))
      if (signal.aborted || deps.agent() !== session) return
      if (result.type === "image") attachImages([result.image])
      else if (result.type === "text") pasteText(result.text)
      else showNote("No image or text on the clipboard. You can also paste an image file path.")
    } catch (err) {
      if (!signal.aborted) showNote(err instanceof Error ? err.message : String(err))
    } finally {
      if (clipboardRead === read) clipboardRead = undefined
      if (!clipboardAbort.signal.aborted) redraw()
    }
  }
  // The "/" popup lists commands, the "$" one skills; at most one is open, by the first character.
  const popups = commands
    ? [
        new CommandPopup(commands, deps.requestRender, keys),
        new CommandPopup(
          { complete: (line) => commands.completeSkill(line), list: () => commands.skills() },
          deps.requestRender,
          keys,
          "$",
        ),
      ]
    : []
  const openPopup = () => popups.find((p) => p.open)
  const historyNav = new HistoryNavigator(history, editor)
  const search = new HistorySearch(history, editor, keys)
  /** The project's files for the @ picker; one the UI made itself it also stops on quit. */
  const ownFiles = deps.files ? undefined : new FileIndex(deps.agent().cwd)
  const filePicker = new FilePicker(deps.files ?? ownFiles!, deps.requestRender, keys)
  /**
   * Tells the completion lists what the editor holds; a promise while commands' candidates are
   * on their way. Cheap on any text: the command popup only looks at a single line, the file
   * picker at the caret's line up to the caret, and it never waits for the project's files.
   * A prompt ↑/↓ recalled opens no list until it is edited: the list would take ↑/↓, and the
   * walk would stop at the first "/status", "$skill" or "@file" in the history.
   */
  const syncCompletions = (): Promise<void> | undefined => {
    const recalled = historyNav.recalling
    const hasImages = editor.getParts().some((p) => typeof p !== "string" && "image" in p)
    const line = editor.lineCount === 1 && !recalled && !hasImages ? editor.getText() : ""
    const commandsPending = popups.map((p) => p.update(line)).find(Boolean)
    const claimed = !hasImages && commands?.inputLine(editor.getText())
    filePicker.update(recalled || claimed ? "" : editor.textBeforeCaret())
    return commandsPending
  }

  /** The input's editing keys beyond typing: the kill ring, undo and redo, the external editor. */
  function editKey(e: InputEvent): boolean {
    if (keys.is(e, "edit.kill-to-start")) editor.killToLineStart()
    else if (keys.is(e, "edit.kill-to-end")) editor.killToLineEnd()
    else if (keys.is(e, "edit.kill-word")) editor.killWordBefore()
    else if (keys.is(e, "edit.yank")) editor.yank()
    else if (keys.is(e, "edit.undo")) editor.undo()
    else if (keys.is(e, "edit.redo")) editor.redo()
    else if (keys.is(e, "edit.external")) editExternally()
    else return false
    return true
  }

  // Edits the message in $VISUAL, $EDITOR, git core.editor, or the platform's default editor.
  // The terminal is handed over until it exits, then the file's text is the input's.
  function editExternally() {
    if (editor.getParts().some((p) => typeof p !== "string" && "image" in p)) {
      showNote("Remove image attachments before using the external text editor.")
      return
    }
    const command = externalEditor(env, deps.agent().cwd)
    const file = join(tmpdir(), `amira-message-${process.pid}-${Date.now()}.md`)
    try {
      writeFileSync(file, editor.getText())
    } catch (err) {
      showNote(`Cannot write the message for the editor: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    let result: ReturnType<typeof spawnSync> | undefined
    let failed: unknown
    try {
      const resume = terminal.suspend?.()
      try {
        result = spawnSync(`${command} "${file}"`, {
          cwd: deps.agent().cwd,
          stdio: "inherit",
          shell: true,
          env: { ...process.env, ...env },
        })
      } finally {
        resume?.()
      }
    } catch (err) {
      failed = err
    }
    try {
      if (!result)
        showNote(`Cannot start ${command}: ${failed instanceof Error ? failed.message : String(failed)}`)
      else if (result.error) showNote(`Cannot start ${command}: ${result.error.message}`)
      else if (result.status !== 0)
        showNote(`${command} exited with ${result.status ?? result.signal}; the message is unchanged`)
      else {
        // Editors end the file with a line break the message did not have.
        const text = readFileSync(file, "utf8").replace(/\r\n?/g, "\n").replace(/\n$/, "")
        if (text !== editor.getText()) editor.setText(text)
      }
    } catch (err) {
      showNote(`Cannot read the message back: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      rmSync(file, { force: true })
    }
    deps.redrawTerminal()
  }

  /** Applies what the popup did with a key; false when it left the key to the editor. */
  function handlePopupKey(e: InputEvent): boolean {
    const action = openPopup()!.handleKey(e)
    if (!action) return false
    if (action.type === "replace") editor.setText(action.text)
    else if (action.type === "run") {
      history.add([action.line])
      historyNav.reset()
      editor.clear()
      deps.runPopup(action.line)
    }
    return true
  }

  /** Applies what the file picker did with a key; false when it left the key to the editor. */
  function handleFileKey(e: InputEvent): boolean {
    const action = filePicker.handleKey(e)
    if (!action) return false
    if (action.type === "insert") {
      const path = action.text
        .slice(1)
        .trim()
        .replace(/^"(.*)"$/, "$1")
      if (!path.endsWith("/") && imageMimeType(path)) {
        try {
          const image = readImage(join(deps.agent().cwd, path))
          if (imageBytes([...editor.getParts(), { image }]) > MAX_IMAGE_BYTES)
            showNote(
              "Images in a message are limited to 5 MB total. Remove an attachment or resize it first.",
            )
          else {
            editor.replaceBeforeCaret(action.replace, "")
            attachImages([image])
          }
        } catch (err) {
          showNote(err instanceof Error ? err.message : String(err))
        }
      } else editor.replaceBeforeCaret(action.replace, action.text)
    }
    return true
  }

  return {
    search,
    popups,
    filePicker,
    get clipboardPending() {
      return clipboardRead !== undefined
    },
    cancelClipboard,
    abortClipboard() {
      clipboardAbort.abort()
    },
    dispose() {
      filePicker.dispose()
      ownFiles?.dispose()
    },
    resetHistory() {
      historyNav.reset()
    },
    syncCompletions,
    prepareInput(e) {
      if (search.active) return
      // Recalled skills use the same Enter guard as typed ones, without taking the history's arrows.
      if (
        historyNav.recalling &&
        editor.lineCount === 1 &&
        editor.getText().startsWith("$") &&
        keys.is(e, "popup.accept")
      )
        historyNav.reset()
      // Keys of one input chunk arrive before the next frame; the popup must not answer Enter
      // with candidates for text the editor no longer holds.
      syncCompletions()
    },
    handleSearchKey(e) {
      return search.handleKey(e)
    },
    handleCompletionKey(e) {
      if (openPopup() && handlePopupKey(e)) return true
      return filePicker.visible && handleFileKey(e)
    },
    handleInput(e) {
      if (keys.is(e, "paste.image") || (e.type === "paste" && !e.text)) {
        void pasteClipboard()
      } else if (e.type === "paste") {
        pasteText(e.text)
      } else if (keys.is(e, "history.search")) {
        search.start()
      } else if (
        (keys.is(e, "history.prev") || keys.is(e, "history.next")) &&
        historyNav.move(keys.is(e, "history.prev") ? -1 : 1)
      ) {
        // The key walked the prompt history.
      } else return false
      return true
    },
    editKey,
    handleEditorInput(e) {
      editor.handleInput(e)
    },
  }
}
