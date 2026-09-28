import { expect, test } from "bun:test"
import { Editor, key, textKey } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { HistorySearch } from "../src/history-search.ts"
import { PromptHistory } from "../src/prompt-history.ts"

function setup(entries: string[], draft = "") {
  const history = new PromptHistory()
  for (const e of entries) history.add([e])
  const editor = new Editor()
  editor.setText(draft)
  const search = new HistorySearch(history, editor)
  search.start()
  const type = (s: string) => {
    for (const ch of s) search.handleKey(textKey(ch))
  }
  const line = () => search.render(80, plain)[0]
  return { editor, search, type, line }
}

test("typing finds the newest entry containing the query; Ctrl+R steps to older ones", () => {
  const { editor, search, type, line } = setup(["fix the tests", "run bun test", "deploy", "Test again"])
  expect(line()).toBe("⌕ search history ›   type to search")
  type("test")
  expect(editor.getText()).toBe("Test again")
  expect(line()).toBe("⌕ search history › test  1 of 3")
  search.handleKey(key("r", { ctrl: true }))
  expect(editor.getText()).toBe("run bun test")
  search.handleKey(key("r", { ctrl: true }))
  search.handleKey(key("r", { ctrl: true }))
  // Past the oldest match it stays put.
  expect(editor.getText()).toBe("fix the tests")
  expect(line()).toBe("⌕ search history › test  3 of 3")
  search.handleKey(key("s", { ctrl: true }))
  expect(editor.getText()).toBe("run bun test")
})

test("a query that matches nothing says so and shows the draft; backspace widens it again", () => {
  const { editor, search, type, line } = setup(["alpha", "beta"], "my draft")
  type("alz")
  expect(line()).toContain("no match")
  expect(editor.getText()).toBe("my draft")
  search.handleKey(key("backspace"))
  expect(editor.getText()).toBe("alpha")
})

test("Enter keeps the match for editing, Esc puts the draft back", () => {
  const a = setup(["alpha", "beta"], "draft")
  a.type("be")
  expect(a.search.handleKey(key("enter"))).toBe("accepted")
  expect(a.search.active).toBe(false)
  expect(a.editor.getText()).toBe("beta")
  const b = setup(["alpha", "beta"], "draft")
  b.type("al")
  expect(b.search.handleKey(key("escape"))).toBe("cancelled")
  expect(b.editor.getText()).toBe("draft")
  const c = setup(["alpha"], "draft")
  c.type("al")
  expect(c.search.handleKey(key("c", { ctrl: true }))).toBe("cancelled")
  expect(c.editor.getText()).toBe("draft")
})

test("other keys keep the match and are passed on", () => {
  const { editor, search, type } = setup(["alpha"])
  type("lp")
  expect(search.handleKey(key("left"))).toBe("accepted-pass")
  expect(editor.getText()).toBe("alpha")
})

test("Ctrl+R with no query walks every entry, newest first", () => {
  const { editor, search } = setup(["one", "two"])
  search.handleKey(key("r", { ctrl: true }))
  expect(editor.getText()).toBe("two")
  search.handleKey(key("r", { ctrl: true }))
  expect(editor.getText()).toBe("one")
})
