import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { projectKey } from "@amira/core"
import { defaultTheme, Editor, key, textKey } from "@amira/tui-kit"

const plainTheme = () => defaultTheme

import { HistoryNavigator, PromptHistory } from "../src/prompt-history.ts"

const dir = mkdtempSync(path.join(os.tmpdir(), "amira-history-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const file = () => path.join(dir, `h${++n}`, "history.jsonl")

const texts = (h: PromptHistory) => h.entries.map((e) => e.text)

test("image prompts can be recalled but their payload is not duplicated into project history", () => {
  const target = file()
  const h = new PromptHistory({ file: target })
  const image = { name: "a.png", mimeType: "image/png", data: "YWJj" }
  h.add([{ image }])
  expect(h.entries[0]?.display).toBe("[image 1: a.png 3 B]")
  expect(existsSync(target)).toBe(false)
  const ed = new Editor()
  const nav = new HistoryNavigator(h, ed)
  expect(nav.move(-1)).toBe(true)
  expect(ed.getParts()).toEqual([{ image }])
  h.add(["plain"])
  expect(readFileSync(target, "utf8")).toBe('{"text":"plain"}\n')
})

test("entries are unique, newest last, and capped", () => {
  const h = new PromptHistory({ limit: 3 })
  for (const t of ["a", "b", "a", "c", "d"]) h.add([t])
  expect(texts(h)).toEqual(["a", "c", "d"])
  h.add(["   "])
  expect(texts(h)).toEqual(["a", "c", "d"])
})

test("the history is saved as JSONL and loaded again, folded pastes included", () => {
  const f = file()
  const h = new PromptHistory({ file: f })
  h.add(["first"])
  h.add(["see ", { paste: "l1\nl2" }])
  h.add(["first"])
  const lines = readFileSync(f, "utf8").trim().split("\n")
  expect(lines.map((l) => JSON.parse(l))).toEqual([
    { text: "first" },
    { parts: ["see ", { paste: "l1\nl2" }] },
    { text: "first" },
  ])
  const again = new PromptHistory({ file: f })
  expect(again.entries.map((e) => e.parts)).toEqual([["see ", { paste: "l1\nl2" }], ["first"]])
  expect(again.entries[0]!.display).toBe("see [pasted 2 lines #1]")
  expect(again.entries[0]!.text).toBe("see l1\nl2")
})

test("a missing file is an empty history; broken lines are skipped", () => {
  expect(new PromptHistory({ file: file() }).entries).toEqual([])
  const f = file()
  new PromptHistory({ file: f }).add(["ok"])
  writeFileSync(f, `${readFileSync(f, "utf8")}not json\n{"parts":[1]}\n{"text":"fine"}\n{"text":`)
  expect(texts(new PromptHistory({ file: f }))).toEqual(["ok", "fine"])
})

test("a file grown to twice the cap is rewritten without duplicates", () => {
  const f = file()
  const h = new PromptHistory({ file: f, limit: 3 })
  for (let i = 0; i < 6; i++) h.add([`m${i % 4}`])
  expect(readFileSync(f, "utf8").trim().split("\n")).toHaveLength(6)
  const loaded = new PromptHistory({ file: f, limit: 3 })
  expect(texts(loaded)).toEqual(["m3", "m0", "m1"])
  expect(readFileSync(f, "utf8").trim().split("\n")).toEqual([
    '{"text":"m3"}',
    '{"text":"m0"}',
    '{"text":"m1"}',
  ])
})

test("each project has its own file under the user directory's history folder", () => {
  const h = PromptHistory.forProject("/work/proj", path.join(dir, "home"))
  expect(h.file).toBe(path.join(dir, "home", "history", `${projectKey("/work/proj")}.jsonl`))
  expect(PromptHistory.forProject("/work/other", dir).file).not.toBe(
    PromptHistory.forProject("/work/proj", dir).file,
  )
})

function nav(entries: string[]) {
  const history = new PromptHistory()
  for (const e of entries) history.add([e])
  const editor = new Editor()
  const n = new HistoryNavigator(history, editor)
  return { history, editor, nav: n }
}

test("↑ on an empty editor recalls the newest entry, then older ones; ↓ comes back to empty", () => {
  const { editor, nav: n } = nav(["one", "two", "three"])
  expect(n.move(1)).toBe(false)
  expect(n.move(-1)).toBe(true)
  expect(editor.getText()).toBe("three")
  n.move(-1)
  n.move(-1)
  expect(editor.getText()).toBe("one")
  // At the oldest, ↑ is taken but changes nothing.
  expect(n.move(-1)).toBe(true)
  expect(editor.getText()).toBe("one")
  n.move(1)
  expect(editor.getText()).toBe("two")
  n.move(1)
  n.move(1)
  expect(editor.isEmpty).toBe(true)
  expect(n.move(1)).toBe(false)
})

test("↑ does nothing for a draft, and stops walking once the recalled text is edited", () => {
  const { editor, nav: n } = nav(["one", "two"])
  editor.handleInput(textKey("draft"))
  expect(n.move(-1)).toBe(false)
  editor.clear()
  n.move(-1)
  editor.handleInput(textKey("!"))
  expect(n.move(-1)).toBe(false)
  expect(n.move(1)).toBe(false)
  expect(editor.getText()).toBe("two!")
})

test("a recalled multi-line entry walks on from its first line (↑) and last line (↓)", () => {
  const { editor, nav: n } = nav(["old", "a\nb\nc", "new"])
  n.move(-1)
  n.move(-1)
  expect(editor.getText()).toBe("a\nb\nc")
  // The caret sits on the first line, so ↑ keeps walking.
  expect(editor.cursor).toEqual({ line: 0, col: 1 })
  // ↓ is left to the editor until the caret is on the last line.
  expect(n.move(1)).toBe(false)
  editor.handleInput(key("down"))
  expect(n.move(1)).toBe(false)
  editor.handleInput(key("down"))
  expect(n.move(1)).toBe(true)
  expect(editor.getText()).toBe("new")
  n.move(-1)
  expect(n.recalling).toBe(true)
  n.move(-1)
  expect(editor.getText()).toBe("old")
})

test("a recalled entry with a folded paste comes back folded", () => {
  const history = new PromptHistory()
  history.add(["log: ", { paste: "x\n".repeat(20) }])
  const editor = new Editor()
  new HistoryNavigator(history, editor).move(-1)
  expect(editor.getDisplayText()).toBe("log: [pasted 20 lines #1]")
  expect(editor.getText()).toBe(`log: ${"x\n".repeat(20)}`)
})

test("in a recalled entry that wraps, ↑ first walks up its rows", () => {
  const h = new PromptHistory()
  h.add(["older"])
  h.add(["a long entry that wraps over several rows of the editor"])
  const ed = new Editor({ prompt: "> " })
  const nav = new HistoryNavigator(h, ed)
  expect(nav.move(-1)).toBe(true)
  ed.setCursor({ line: 0, col: Number.POSITIVE_INFINITY })
  ed.render(20, { theme: plainTheme() } as never)
  // The caret is on the last row of the entry: ↑ is the editor's.
  expect(nav.move(-1)).toBe(false)
  ed.setCursor({ line: 0, col: 0 })
  expect(nav.move(-1)).toBe(true)
  expect(ed.getText()).toBe("older")
})
