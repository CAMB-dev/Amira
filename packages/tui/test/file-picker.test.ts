import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { key } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { FileIndex, listProjectFiles, withDirectories } from "../src/file-index.ts"
import { atReference, FilePicker, fuzzyScore, rankFiles } from "../src/file-picker.ts"
import { AsyncList } from "../src/picker.ts"

const files = [
  "README.md",
  "package.json",
  "packages/tui/src/app.ts",
  "packages/tui/src/file-picker.ts",
  "packages/tui/test/app.test.ts",
  "packages/tui-kit/src/components/editor.ts",
  "packages/core/src/agent.ts",
  "docs/app-notes.md",
  "extensions/web/src/fetch-page.ts",
]

test("atReference finds the @word being typed", () => {
  expect(atReference("@")).toEqual({ query: "" })
  expect(atReference("look at @src/ap")).toEqual({ query: "src/ap" })
  expect(atReference("mail me@example")).toBeUndefined()
  expect(atReference("@done ")).toBeUndefined()
  expect(atReference("two @a@b")).toBeUndefined()
})

test("the file name counts most, then the path, then letters in order", () => {
  expect(rankFiles("app", files).slice(0, 3)).toEqual([
    "packages/tui/src/app.ts",
    "docs/app-notes.md",
    "packages/tui/test/app.test.ts",
  ])
  expect(rankFiles("editor", files)[0]).toBe("packages/tui-kit/src/components/editor.ts")
  // Letters in order: f(ile)-p(icker) beats f(etch)-p(age) on word starts and closeness.
  expect(rankFiles("fpick", files)).toEqual(["packages/tui/src/file-picker.ts"])
  expect(rankFiles("fp", files).slice(0, 2).sort()).toEqual([
    "extensions/web/src/fetch-page.ts",
    "packages/tui/src/file-picker.ts",
  ])
  expect(rankFiles("zzz", files)).toEqual([])
  // Case does not matter.
  expect(rankFiles("readme", files)).toEqual(["README.md"])
})

test("a query with a slash matches the path", () => {
  expect(rankFiles("tui/src", files).slice(0, 2)).toEqual([
    "packages/tui/src/app.ts",
    "packages/tui/src/file-picker.ts",
  ])
  expect(rankFiles("core/", files)).toEqual(["packages/core/src/agent.ts"])
})

test("an empty query lists the shallowest entries first", () => {
  expect(rankFiles("", withDirectories(files)).slice(0, 5)).toEqual([
    "README.md",
    "docs/",
    "extensions/",
    "package.json",
    "packages/",
  ])
})

test("the empty-query list matches a full sort by depth then name, and is cheap in a big repo", () => {
  const big: string[] = []
  for (let i = 0; i < 30_000; i++) big.push(`pkg${i % 37}/src/m${(i * 7919) % 30_000}/f${i}.ts`)
  for (let i = 0; i < 20; i++) big.push(`top${(i * 13) % 20}.md`)
  const all = withDirectories(big)
  const depth = (p: string) => p.replace(/\/$/, "").split("/").length
  const naive = (limit: number) =>
    [...all].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, limit)
  for (const limit of [5, 20, 50, 57, 60, 100]) expect(rankFiles("", all, limit)).toEqual(naive(limit))
  // Every bare "@" asks again: answered from the cache, not by sorting the list.
  const start = performance.now()
  for (let i = 0; i < 100; i++) rankFiles("", all, 100)
  expect(performance.now() - start).toBeLessThan(50)
  expect(rankFiles("", ["a/b.ts", "c.ts"], 10)).toEqual(["c.ts", "a/b.ts"])
})

test("after a directory is inserted its contents come first, not the directory again", () => {
  const list = withDirectories(["src/app.ts", "src/format.ts", "src/deep/x.ts", "README.md"])
  const ranked = rankFiles("src/", list)
  expect(ranked).not.toContain("src/")
  expect(ranked.slice(0, 3)).toEqual(["src/deep/", "src/app.ts", "src/format.ts"])
  // A file named exactly as typed is still offered.
  expect(rankFiles("readme.md", list)).toEqual(["README.md"])
})

test("fuzzyScore favours exact names and short paths", () => {
  expect(fuzzyScore("app.ts", "src/app.ts")!).toBeGreaterThan(fuzzyScore("app.ts", "src/deep/app.ts")!)
  expect(fuzzyScore("app", "app.ts")!).toBeGreaterThan(fuzzyScore("app", "happy.ts")!)
  expect(fuzzyScore("xyz", "app.ts")).toBeUndefined()
})

test("withDirectories adds each directory once", () => {
  expect(withDirectories(["a/b/c.ts", "a/d.ts", "e.ts"])).toEqual([
    "a/b/c.ts",
    "a/d.ts",
    "e.ts",
    "a/",
    "a/b/",
  ])
})

const tick = () => Bun.sleep(1)

test("the picker opens for @, inserts the chosen path with a space, and a directory without one", async () => {
  let updates = 0
  const picker = new FilePicker({ files: async () => withDirectories(files) }, () => updates++)
  picker.update("see @")
  await tick()
  expect(picker.open).toBe(true)
  picker.update("see @edit")
  await tick()
  expect(picker.render(60, plain)).toEqual(["› packages/tui-kit/src/components/editor.ts"])
  expect(picker.handleKey(key("tab"))).toEqual({
    type: "insert",
    replace: 5,
    text: "@packages/tui-kit/src/components/editor.ts ",
  })
  picker.update("@packages/tui-")
  await tick()
  expect(picker.handleKey(key("enter"))).toEqual({ type: "insert", replace: 14, text: "@packages/tui-kit/" })
  expect(updates).toBeGreaterThan(0)
})

test("↑↓ move the selection, Esc closes until the word changes, other keys pass", async () => {
  const picker = new FilePicker({ files: async () => files }, () => {})
  picker.update("@app")
  await tick()
  expect(picker.handleKey(key("down"))).toEqual({ type: "handled" })
  expect(picker.render(60, plain)[1]).toBe("› docs/app-notes.md")
  expect(picker.handleKey(key("left"))).toBeUndefined()
  expect(picker.handleKey(key("escape"))).toEqual({ type: "handled" })
  expect(picker.open).toBe(false)
  expect(picker.render(60, plain)).toEqual([])
  picker.update("@apps")
  picker.update("@app")
  await tick()
  expect(picker.open).toBe(true)
  picker.update("no reference")
  expect(picker.open).toBe(false)
  expect(picker.handleKey(key("tab"))).toBeUndefined()
})

test("paths with spaces are quoted", async () => {
  const picker = new FilePicker({ files: async () => ["my notes/todo list.md"] }, () => {})
  picker.update("@todo")
  await tick()
  expect(picker.handleKey(key("tab"))).toEqual({
    type: "insert",
    replace: 5,
    text: '@"my notes/todo list.md" ',
  })
})

test("AsyncList drops stale answers and keeps drawing the last list while the next loads", async () => {
  const pending: Record<string, (items: string[]) => void> = {}
  const list = new AsyncList<string>(
    (k) =>
      new Promise((resolve) => {
        pending[k] = resolve
      }),
    () => {},
  )
  list.update("a")
  pending.a!(["a1", "a2"])
  await tick()
  expect(list.open).toBe(true)
  list.update("ab")
  // Not answered yet: still drawn, but not taking keys.
  expect(list.visible).toBe(true)
  expect(list.open).toBe(false)
  list.update("abc")
  pending.ab!(["stale"])
  await tick()
  expect(list.shown).toEqual(["a1", "a2"])
  pending.abc!(["abc1"])
  await tick()
  expect(list.current).toEqual(["abc1"])
  list.update(undefined)
  expect(list.visible).toBe(false)
})

test("FileIndex lists once, then answers from its cache and refreshes in the background when stale", async () => {
  let calls = 0
  let answer = ["a.ts"]
  const index = new FileIndex("/x", {
    ttlMs: 20,
    list: async () => {
      calls++
      return answer
    },
  })
  expect(await index.files()).toEqual(["a.ts"])
  expect(await index.files()).toEqual(["a.ts"])
  expect(calls).toBe(1)
  await Bun.sleep(30)
  answer = ["a.ts", "b/c.ts"]
  // Stale: the old list comes back at once, the new one is on its way.
  expect(await index.files()).toEqual(["a.ts"])
  await tick()
  expect(await index.files()).toEqual(["a.ts", "b/c.ts", "b/"])
  expect(calls).toBe(2)
})

const tmp = mkdtempSync(path.join(os.tmpdir(), "amira-files-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function tree(root: string, paths: string[]) {
  for (const p of paths) {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
    writeFileSync(path.join(root, p), "")
  }
}

test("outside a repository the files are walked, skipping .git and node_modules", async () => {
  const root = path.join(tmp, "plain")
  tree(root, ["b.ts", "a/x.ts", "node_modules/m/i.js", "a/node_modules/y.js"])
  expect(await listProjectFiles(root)).toEqual(["b.ts", "a/x.ts"])
  expect(await listProjectFiles(root, { limit: 1 })).toEqual(["b.ts"])
})

const hasGit = Bun.which("git") !== null

test.skipIf(!hasGit)("in a repository git lists the files, leaving out what .gitignore ignores", async () => {
  const root = path.join(tmp, "repo")
  tree(root, [".gitignore", "src/app.ts", "dist/out.js", "notes.md"])
  writeFileSync(path.join(root, ".gitignore"), "dist/\n")
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: root })
  expect(init.exitCode).toBe(0)
  expect((await listProjectFiles(root)).sort()).toEqual([".gitignore", "notes.md", "src/app.ts"])
})
