import { expect, test } from "bun:test"
import { listProjectFiles, MAX_FILES, streamProjectFiles } from "@amira/core"
import * as fileIndex from "../src/file-index.ts"
import type {
  ExtensionViewerOptions,
  FrontendConversationRef,
  FrontendConversationSnapshot,
  FrontendConversationSource,
  FrontendConversationUpdate,
  FrontendEffect,
  InteractiveOptions,
} from "../src/index.ts"

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

test("remote frontend effect and conversation DTO types are exported without executable host handles", async () => {
  const ref: FrontendConversationRef = { conversationId: "remote-child", incarnation: "opaque" }
  const snapshot: FrontendConversationSnapshot = {
    ...ref,
    name: "Child",
    cwd: "/remote/child",
    messages: [],
    busy: false,
    renderedTurnIds: ["turn"],
  }
  const updates: FrontendConversationUpdate[] = []
  const source: FrontendConversationSource = {
    containsSession: (root, sessionId) => root === sessionId,
    async open(_ref, listener) {
      listener({ kind: "snapshot", snapshot })
      return { snapshot, dispose() {} }
    },
  }
  const effect: FrontendEffect = { kind: "focus", ...ref }
  const options: Pick<
    InteractiveOptions,
    "conversations" | "subscribeFrontendEffects" | "bindCommandFrontend" | "completions"
  > = {
    conversations: source,
    subscribeFrontendEffects(listener) {
      listener(effect)
      return () => {}
    },
  }
  const opened = await options.conversations!.open(ref, (update) => updates.push(update))
  expect(Object.keys(opened.snapshot).sort()).toEqual([
    "busy",
    "conversationId",
    "cwd",
    "incarnation",
    "messages",
    "name",
    "renderedTurnIds",
  ])
  expect(source.containsSession!("remote-child", "remote-child")).toBe(true)
  expect(updates).toEqual([{ kind: "snapshot", snapshot }])
  opened.dispose()
})

test("public viewer options expose boolean and web-only hyperlink policies", () => {
  const policies: Pick<ExtensionViewerOptions, "hyperlinks">[] = [
    { hyperlinks: "web" },
    { hyperlinks: true },
    { hyperlinks: false },
    {},
  ]
  expect(policies).toEqual([{ hyperlinks: "web" }, { hyperlinks: true }, { hyperlinks: false }, {}])
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
