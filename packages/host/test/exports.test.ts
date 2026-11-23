import { expect, test } from "bun:test"
import { EventBus } from "@amira/core"
import {
  type FormEditor,
  type ListFiles,
  type ListOptions,
  listProjectFiles,
  MAX_FILES,
  streamProjectFiles,
  UiRequests,
} from "../src/index.ts"

test("local suggestion attachment is a host-only composer seam", () => {
  const ui = new UiRequests(new EventBus())
  const detach = ui.inputSuggestions.attach(() => ({ revision: 0, ready: true }))
  expect({
    attach: typeof ui.inputSuggestions.attach,
    refresh: typeof ui.inputSuggestions.refresh,
    invalidate: typeof ui.inputSuggestions.invalidate,
    acquire: typeof ui.api().acquireInputSuggestionSlot,
  }).toEqual({
    acquire: "function",
    attach: "function",
    invalidate: "function",
    refresh: "function",
  })
  detach()
  expect(ui.api().acquireInputSuggestionSlot()).toBeUndefined()
})

test("form editor identity and resumed revision remain host-library exports", () => {
  const editor: FormEditor = { editor: "editor-1", revision: 7 }
  expect(editor).toEqual({ editor: "editor-1", revision: 7 })
})

test("project file listing functions and options are host-library exports", () => {
  const options: ListOptions = { limit: MAX_FILES, timeoutMs: 15_000 }
  const list: ListFiles = (cwd, emit, signal) => streamProjectFiles(cwd, emit, { ...options, signal })
  expect({ options, list: typeof list, collect: typeof listProjectFiles }).toEqual({
    collect: "function",
    list: "function",
    options: { limit: 250000, timeoutMs: 15000 },
  })
})
