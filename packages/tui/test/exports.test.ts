import { expect, test } from "bun:test"

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
