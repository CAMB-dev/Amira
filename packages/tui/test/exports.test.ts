import { expect, test } from "bun:test"

test("the public TUI exports stay stable", async () => {
  const actual = Object.keys(await import("../src/index.ts")).sort()
  expect(actual).toEqual([
    "ACTIONS",
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
    "runFormScreen",
    "runInteractive",
    "specFormBackend",
    "statusBorder",
    "statusLine",
    "summarizeArgs",
    "uiFormBackend",
    "userLines",
  ])
})
