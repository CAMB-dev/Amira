import { expect, test } from "bun:test"
import { EventBus, UiRequests } from "@amira/core"
import { CURSOR_MARKER, defaultGlyphs, Editor, key, textKey, visibleWidth } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { createPromptInput } from "../src/app/input-suggestion.ts"
import { InputBox } from "../src/input-box.ts"
import { defaultKeybindings } from "../src/keybindings.ts"

function fixture() {
  const ui = new UiRequests(new EventBus())
  const api = ui.api("suggest")
  const accepted: string[] = []
  const submitted: string[] = []
  let blocked = false
  api.onInputSuggestionAccepted((text) => accepted.push(text))
  const input = createPromptInput({
    ui,
    keys: defaultKeybindings(),
    blocked: () => blocked,
    onSubmit: (text) => submitted.push(text),
  })
  return {
    ui,
    api,
    input,
    accepted,
    submitted,
    block: (value: boolean) => {
      blocked = value
    },
  }
}

test("ghost text replaces only an empty focused prompt's placeholder, without moving its caret", () => {
  const s = fixture()
  const ctx = { ...plain, theme: { ...plain.theme, dim: (text: string) => `[dim]${text}[/dim]` } }
  const box = new InputBox(s.input.editor, undefined, s.input.visible)
  s.api.setInputSuggestion("Try the tests")
  const row = box.render(60, ctx)[1]!
  expect(row).toContain(`${CURSOR_MARKER}[dim]Try the tests[/dim]`)
  expect(visibleWidth(row.split(CURSOR_MARKER)[0]!)).toBe(4)
  expect(s.input.editor.isEmpty).toBe(true)
  for (const text of ["x", " ", "\n"]) {
    s.input.editor.setText(text)
    expect(box.render(60, plain).join("\n")).not.toContain("Try the tests")
  }
  s.input.editor.clear()
  s.input.editor.focused = false
  expect(box.render(60, plain).join("\n")).not.toContain("Try the tests")
  s.input.editor.focused = true
  s.block(true)
  expect(box.render(60, plain).join("\n")).not.toContain("Try the tests")
})

test("ghost text uses the active ellipsis and fits both framed and bare input widths", () => {
  const s = fixture()
  const box = new InputBox(s.input.editor, undefined, s.input.visible)
  s.api.setInputSuggestion("abcdefghijk你好uvwxyz")
  for (const [glyphs, more] of [
    [undefined, "…"],
    [{ ...defaultGlyphs, pointer: ">", more: "..." }, "..."],
  ] as const) {
    for (const width of [7, 8, 14, 30]) {
      const rows = box.render(width, { ...plain, glyphs })
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)
      const body = rows.find((row) => row.includes(CURSOR_MARKER))!
      if (width < 20 && (width !== 8 || more === "…")) expect(body).toContain(more)
      expect(body).not.toContain("Message Amira")
    }
  }
})

test("only plain Tab accepts visible text, inserts without submitting, and leaves the cursor at the end", () => {
  const s = fixture()
  s.api.setInputSuggestion("Run tests")
  expect(s.input.handleInput(key("right"))).toBe(false)
  expect(s.input.handleInput(key("tab", { shift: true }))).toBe(false)
  expect(s.input.handleInput(key("tab", { ctrl: true }))).toBe(false)
  expect(s.input.handleInput(key("tab"))).toBe(true)
  expect(s.input.editor.getText()).toBe("Run tests")
  expect(s.input.editor.textBeforeCaret()).toBe("Run tests")
  expect(s.accepted).toEqual(["Run tests"])
  expect(s.submitted).toEqual([])
  expect(s.input.visible()).toBeUndefined()
  expect(s.input.handleInput(key("tab"))).toBe(false)
})

test("hidden suggestions never consume Tab; absence leaves Tab's editor behavior unchanged", () => {
  const s = fixture()
  s.api.setInputSuggestion("Never accept hidden text")
  s.block(true)
  expect(s.input.handleInput(key("tab"))).toBe(false)
  s.block(false)
  s.input.editor.setText("draft")
  expect(s.input.handleInput(key("tab"))).toBe(false)
  s.input.editor.clear()
  s.input.editor.focused = false
  expect(s.input.handleInput(key("tab"))).toBe(false)
  expect(s.accepted).toEqual([])
  s.api.setInputSuggestion(undefined)
  s.input.editor.focused = true
  const normal = new Editor()
  s.input.editor.handleInput(key("tab"))
  normal.handleInput(key("tab"))
  expect(s.input.editor.getText()).toBe(normal.getText())
})

test("typing, pasting, history and all send keys dismiss suggestions before editing or submitting", () => {
  const s = fixture()
  for (const event of [
    textKey("x"),
    { type: "paste", text: "pasted" } as const,
    key("up"),
    key("down"),
    key("r", { ctrl: true }),
    key("backspace"),
    key("delete"),
    key("u", { ctrl: true }),
    key("k", { ctrl: true }),
    key("w", { ctrl: true }),
    key("y", { ctrl: true }),
    key("z", { ctrl: true }),
    key("enter", { shift: true }),
    key("enter"),
    key("q", { ctrl: true }),
  ]) {
    s.api.setInputSuggestion("Dismiss me")
    expect(s.input.handleInput(event)).toBe(false)
    expect(s.ui.inputSuggestions.text).toBeUndefined()
  }
  expect(s.accepted).toEqual([])
  s.api.setInputSuggestion("Dismiss on submit")
  s.input.editor.setText("actual message")
  s.input.editor.handleInput(key("enter"))
  expect(s.ui.inputSuggestions.text).toBeUndefined()
  expect(s.submitted).toEqual(["actual message"])
})
