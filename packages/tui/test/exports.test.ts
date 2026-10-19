import { expect, test } from "bun:test"
import { listProjectFiles, MAX_FILES, streamProjectFiles } from "@amira/core"
import * as fileIndex from "../src/file-index.ts"

test("file-index preserves its existing exports and reexports the core listing IO", () => {
  expect(Object.keys(fileIndex).sort()).toEqual([
    "FileIndex",
    "MAX_FILES",
    "fileList",
    "listProjectFiles",
    "streamProjectFiles",
    "withDirectories",
  ])
  expect(fileIndex.listProjectFiles).toBe(listProjectFiles)
  expect(fileIndex.streamProjectFiles).toBe(streamProjectFiles)
  expect(fileIndex.MAX_FILES).toBe(MAX_FILES)
})

test("the public TUI exports stay stable", async () => {
  const exports = await import("../src/index.ts")
  const actual = Object.keys(exports).sort()
  expect(actual).toEqual([
    "ACTIONS",
    "ExtensionSettingsView",
    "ExtensionViewer",
    "FormView",
    "HISTORY_LIMIT",
    "Keybindings",
    "PromptHistory",
    "defaultKeys",
    "fallbackPresenter",
    "finishedToolLines",
    "glyphs",
    "loadKeybindings",
    "operationFormBackend",
    "runFormScreen",
    "runInteractive",
    "specFormBackend",
    "statusBorder",
    "statusLine",
    "summarizeArgs",
    "uiExtensionSettingsBackend",
    "uiFormBackend",
    "userLines",
  ])
  expect(Object.keys(exports.ACTIONS).filter((action) => action.startsWith("view."))).toEqual([
    "view.back",
    "view.close",
    "view.focus",
    "view.scroll-up",
    "view.scroll-down",
  ])
})
