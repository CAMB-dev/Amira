import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { key } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { FileIndex, fileList, listProjectFiles, withDirectories } from "../src/file-index.ts"
import { atReference, FilePicker, fuzzyScore, rankFiles, Search } from "../src/file-picker.ts"

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

/**
 * Waits for the setImmediate work an `emit` starts: first the listing adds the paths, then the
 * picker schedules the search those additions trigger. `Bun.sleep(1)` does not always let both
 * run before the test goes on (under a loaded event loop a timer can resolve first), so use this
 * where the test needs the search to have run rather than merely to have yielded.
 */
async function flushScheduledWork() {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test("the picker opens for @, inserts the chosen path with a space, and a directory without one", async () => {
  let updates = 0
  const picker = new FilePicker(
    fileList(async () => files),
    () => updates++,
  )
  picker.update("see @")
  await tick()
  expect(picker.open).toBe(true)
  picker.update("see @edit")
  expect(picker.render(60, plain)).toEqual(["❯ packages/tui-kit/src/components/editor.ts"])
  expect(picker.handleKey(key("tab"))).toEqual({
    type: "insert",
    replace: 5,
    text: "@packages/tui-kit/src/components/editor.ts ",
  })
  picker.update("@packages/tui-")
  expect(picker.handleKey(key("enter"))).toEqual({ type: "insert", replace: 14, text: "@packages/tui-kit/" })
  expect(updates).toBeGreaterThan(0)
})

test("↑↓ move the selection, Esc closes until the word changes, other keys pass", () => {
  const picker = new FilePicker(fileList(files), () => {})
  picker.update("@app")
  expect(picker.handleKey(key("down"))).toEqual({ type: "handled" })
  expect(picker.render(60, plain)[1]).toBe("❯ docs/app-notes.md")
  expect(picker.handleKey(key("left"))).toBeUndefined()
  expect(picker.handleKey(key("escape"))).toEqual({ type: "handled" })
  expect(picker.open).toBe(false)
  expect(picker.render(60, plain)).toEqual([])
  picker.update("@apps")
  picker.update("@app")
  expect(picker.open).toBe(true)
  picker.update("no reference")
  expect(picker.open).toBe(false)
  expect(picker.handleKey(key("tab"))).toBeUndefined()
})

test("paths with spaces are quoted", () => {
  const picker = new FilePicker(fileList(["my notes/todo list.md"]), () => {})
  picker.update("@todo")
  expect(picker.handleKey(key("tab"))).toEqual({
    type: "insert",
    replace: 5,
    text: '@"my notes/todo list.md" ',
  })
})

/** A source whose listing the test fills by hand, as a slow git or walk would. */
function manualSource() {
  let emit!: (paths: string[]) => void
  let finish!: () => void
  const index = new FileIndex("/x", {
    list: (_cwd, e) => {
      emit = e
      return new Promise<void>((r) => {
        finish = r
      })
    },
  })
  return { index, emit: (paths: string[]) => emit(paths), finish: () => finish() }
}

test("while the project is listed the picker shows a status row, then matches as they arrive", async () => {
  const src = manualSource()
  let updates = 0
  const picker = new FilePicker(src.index, () => updates++)
  picker.update("@app")
  // Shown at once, before any file is known, with a spinner and the count so far.
  expect(picker.visible).toBe(true)
  expect(picker.open).toBe(false)
  expect(picker.render(60, plain)).toEqual(["  ⠋ indexing… 0 files"])
  src.emit(["src/app.ts", "README.md"])
  await tick()
  expect(picker.render(60, plain)).toEqual(["❯ src/app.ts", "  ⠋ indexing… 2 files"])
  // The list keys work on what is there.
  expect(picker.handleKey(key("tab"))).toEqual({ type: "insert", replace: 4, text: "@src/app.ts " })
  src.emit(["app.ts"])
  await tick()
  expect(picker.render(60, plain)).toEqual(["❯ app.ts", "  src/app.ts", "  ⠋ indexing… 3 files"])
  src.finish()
  await tick()
  expect(picker.render(60, plain)).toEqual(["❯ app.ts", "  src/app.ts"])
  expect(updates).toBeGreaterThan(0)
  picker.dispose()
})

test("with only the status row shown, the list keys wait and Esc closes it; other keys pass", () => {
  const src = manualSource()
  const picker = new FilePicker(src.index, () => {})
  picker.update("@x")
  // Enter does not send the half-typed "@x", ↓ does not walk the prompt history.
  expect(picker.handleKey(key("enter"))).toEqual({ type: "handled" })
  expect(picker.handleKey(key("down"))).toEqual({ type: "handled" })
  expect(picker.handleKey(key("left"))).toBeUndefined()
  expect(picker.handleKey(key("escape"))).toEqual({ type: "handled" })
  expect(picker.visible).toBe(false)
  expect(picker.handleKey(key("enter"))).toBeUndefined()
  picker.dispose()
})

test("while a new query is still searched without a match yet, the last list stays drawn", async () => {
  const big = Array.from({ length: 200_000 }, (_, i) => `gen/d${i % 97}/t${i}.ts`).concat(
    "zz/target-match.ts",
  )
  const picker = new FilePicker(fileList(big), () => {})
  picker.update("@t1")
  await waitUntil(() => picker.render(80, plain)[0] === "❯ gen/d1/t1.ts")
  const before = picker.render(80, plain)
  // Only the last entry matches: the first slice finds nothing.
  picker.update("@targ")
  expect(picker.visible).toBe(true)
  expect(picker.open).toBe(false)
  expect(picker.render(80, plain)).toEqual(before)
  expect(picker.handleKey(key("tab"))).toEqual({ type: "handled" })
  await waitUntil(() => picker.render(80, plain)[0] === "❯ zz/target-match.ts")
  expect(picker.open).toBe(true)
  // A query that matches nothing at all closes the list once searched.
  picker.update("@qqq")
  await waitUntil(() => !picker.visible)
  picker.dispose()
})

test("the selection stays on the path moved to while more matches arrive", async () => {
  const src = manualSource()
  const picker = new FilePicker(src.index, () => {})
  picker.update("@b")
  src.emit(["b1.ts", "b2.ts"])
  await flushScheduledWork()
  picker.handleKey(key("down"))
  expect(picker.render(60, plain)[1]).toBe("❯ b2.ts")
  src.emit(["b.ts"])
  await flushScheduledWork()
  expect(picker.render(60, plain)).toEqual(["  b.ts", "  b1.ts", "❯ b2.ts", "  ⠋ indexing… 3 files"])
  picker.dispose()
})

test("a very large listing: a key searches one slice, the rest follows between frames", async () => {
  const big: string[] = []
  for (let i = 0; i < 200_000; i++)
    big.push(`pkg${i % 20}/mod${((i / 20) % 25) | 0}/sub${((i / 500) % 20) | 0}/file${i}.ts`)
  let updates = 0
  const picker = new FilePicker(fileList(big), () => updates++)
  picker.update("@file")
  // Too big to search in the key's slice: the rest comes in later slices, each drawn.
  expect(updates).toBe(0)
  await waitUntil(() => updates > 0)
  picker.update("@file1234")
  await waitUntil(() => picker.render(80, plain)[0] === "❯ pkg14/mod11/sub2/file1234.ts")
  // No status row once the listing is complete.
  expect(picker.render(80, plain).some((l) => l.includes("indexing"))).toBe(false)
  picker.dispose()
})

async function waitUntil(check: () => boolean, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() > deadline) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

test("a search in slices, or refined from a shorter query, finds what a full one does", () => {
  const list = withDirectories([
    ...files,
    ...Array.from({ length: 3000 }, (_, i) => `gen/d${i % 17}/f${i}-app.ts`),
  ])
  for (const q of ["a", "ap", "app", "app.", "tui/", ""]) {
    const whole = rankFiles(q, list)
    const sliced = new Search(q, list)
    while (!sliced.step(0)) {}
    expect(sliced.results).toEqual(whole)
  }
  const first = new Search("a", list)
  first.step(Number.POSITIVE_INFINITY)
  const refined = new Search("app", list, 50, first)
  refined.step(Number.POSITIVE_INFINITY)
  expect(refined.results).toEqual(rankFiles("app", list))
  // Only a longer query over the same listing refines.
  expect(first.canRefine("b", list)).toBe(false)
  expect(first.canRefine("ab", [...list])).toBe(false)
  expect(first.canRefine("ab", list)).toBe(true)
})

test("FileIndex lists once, then answers from its cache and refreshes in the background when stale", async () => {
  let calls = 0
  let answer = ["a.ts"]
  const index = new FileIndex("/x", {
    ttlMs: 20,
    list: async (_cwd, emit) => {
      calls++
      emit(answer)
    },
  })
  let changes = 0
  index.subscribe(() => changes++)
  const first = index.listing()
  await tick()
  expect(first.done).toBe(true)
  expect(index.listing().entries).toEqual(["a.ts"])
  expect(calls).toBe(1)
  expect(changes).toBeGreaterThan(0)
  await Bun.sleep(30)
  answer = ["a.ts", "b/c.ts"]
  // Stale: the old listing is answered at once, the fresh one replaces it once complete.
  expect(index.listing()).toBe(first)
  await tick()
  expect(index.listing().entries).toEqual(["a.ts", "b/c.ts", "b/"])
  expect(calls).toBe(2)
})

test("FileIndex grows its listing in place, each directory once, and stops at its cap", async () => {
  let emit!: (paths: string[]) => void
  let aborted = false
  const index = new FileIndex("/x", {
    limit: 3,
    list: (_cwd, e, signal) => {
      emit = e
      return new Promise<void>((r) => {
        signal.addEventListener("abort", () => {
          aborted = true
          r()
        })
      })
    },
  })
  const listing = index.listing()
  // A path repeated right after itself (a conflicted file's stages) counts once.
  emit(["a/b.ts", "a/b.ts", "a/c.ts"])
  // Added between keys and frames, not while the paths arrive.
  expect(listing.entries).toEqual([])
  await tick()
  expect(index.listing()).toBe(listing)
  expect(listing.entries).toEqual(["a/b.ts", "a/", "a/c.ts"])
  expect(listing.files).toBe(2)
  expect(listing.done).toBe(false)
  emit(["x/d.ts", "e.ts", "f.ts"])
  await tick()
  expect(listing.entries).toEqual(["a/b.ts", "a/", "a/c.ts", "x/d.ts", "x/"])
  expect(listing.files).toBe(3)
  expect(listing.partial).toBe(true)
  expect(aborted).toBe(true)
  await tick()
  expect(listing.done).toBe(true)
  // A capped listing says so under the list.
  const picker = new FilePicker(index, () => {})
  picker.update("@.ts")
  expect(picker.render(60, plain).at(-1)).toBe("  searched the first 3 files")
  picker.dispose()
})

const tmp = mkdtempSync(path.join(os.tmpdir(), "amira-files-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function tree(root: string, paths: string[]) {
  for (const p of paths) {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
    writeFileSync(path.join(root, p), "")
  }
}

test("a listing cut short by its time limit says so; a repository listed as a directory is one entry", async () => {
  const index = new FileIndex("/x", {
    list: async (_cwd, emit) => {
      emit(["a.ts", "nested/", "nested/x/"])
      return false
    },
  })
  const listing = index.listing()
  await waitUntil(() => listing.done)
  expect(listing.partial).toBe(true)
  expect(listing.files).toBe(1)
  expect(listing.entries).toEqual(["a.ts", "nested/", "nested/x/"])
  const picker = new FilePicker(index, () => {})
  picker.update("@a")
  expect(picker.render(60, plain).at(-1)).toBe("  searched the first 1 files")
  picker.dispose()
})

test("a disposed FileIndex stops its listing and tells no one", async () => {
  let aborted = false
  const index = new FileIndex("/x", {
    list: (_cwd, _emit, signal) =>
      new Promise<void>((r) => {
        signal.addEventListener("abort", () => {
          aborted = true
          r()
        })
      }),
  })
  let changes = 0
  index.subscribe(() => changes++)
  index.listing()
  index.dispose()
  await tick()
  expect(aborted).toBe(true)
  expect(changes).toBe(0)
})

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
