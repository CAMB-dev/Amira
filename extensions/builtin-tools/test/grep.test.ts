import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type GrepParams, grepTool } from "../src/grep.ts"
import { makeCtx, tempDirs, textOf } from "./util.ts"

const tmp = tempDirs()
let dir: string
beforeAll(async () => {
  dir = await tmp.make()
  for (const d of ["src/deep", "node_modules/p", ".git"]) await mkdir(join(dir, d), { recursive: true })
  await writeFile(join(dir, "src/a.ts"), "const TODO = 1\n// todo later\nexport {}\n")
  await writeFile(join(dir, "src/deep/b.ts"), "// TODO one\r\n// TODO two\r\n")
  await writeFile(join(dir, "notes.md"), "TODO: write docs\n")
  await writeFile(join(dir, "node_modules/p/i.ts"), "TODO")
  await writeFile(join(dir, ".git/config"), "TODO")
  await writeFile(join(dir, "bin.dat"), new Uint8Array([84, 79, 68, 79, 0]))
})
afterAll(() => tmp.cleanup())

const grep = (params: GrepParams) => grepTool.execute(params, makeCtx(dir))

test("lists matching files by default, skipping binary and ignored dirs", async () => {
  expect(textOf(await grep({ pattern: "TODO" })).split("\n")).toEqual([
    "notes.md",
    "src/a.ts",
    "src/deep/b.ts",
  ])
})

test("content mode shows file:line:text", async () => {
  const r = await grep({ pattern: "todo", ignore_case: true, output_mode: "content", path: "src" })
  expect(textOf(r).split("\n")).toEqual([
    "src/a.ts:1:const TODO = 1",
    "src/a.ts:2:// todo later",
    "src/deep/b.ts:1:// TODO one",
    "src/deep/b.ts:2:// TODO two",
  ])
  expect(r.details).toMatchObject({ mode: "content", matchedFiles: 2, matches: 4, total: 4 })
  const files = await grep({ pattern: "TODO" })
  expect(files.details).toMatchObject({ mode: "files_with_matches", matchedFiles: 3, total: 3 })
  expect((files.details as { matches?: number }).matches).toBeUndefined()
})

test("count mode, glob filter and single-file path", async () => {
  expect(textOf(await grep({ pattern: "TODO", output_mode: "count", glob: "*.ts" })).split("\n")).toEqual([
    "src/a.ts:1",
    "src/deep/b.ts:2",
  ])
  expect(textOf(await grep({ pattern: "TODO", glob: "src/deep/**" }))).toBe("src/deep/b.ts")
  expect(textOf(await grep({ pattern: "docs", path: "notes.md", output_mode: "content" }))).toBe(
    "notes.md:1:TODO: write docs",
  )
})

test("head_limit caps output and says so", async () => {
  const r = textOf(await grep({ pattern: "TODO", output_mode: "content", head_limit: 2 }))
  expect(r).toStartWith("notes.md:1:TODO: write docs\nsrc/a.ts:1:const TODO = 1\n\n(Showing 2 of 4")
})

test("errors on invalid regex and missing path; no matches is not an error", async () => {
  expect((await grep({ pattern: "(" })).isError).toBe(true)
  expect((await grep({ pattern: "x", path: "missing" })).isError).toBe(true)
  const none = await grep({ pattern: "zzz_nothing" })
  expect(none.isError).toBeUndefined()
  expect(textOf(none)).toContain("No matches")
})

test("only the first 10,000 characters of a line are searched", async () => {
  await writeFile(join(dir, "long.txt"), `${"a".repeat(9_000)}NEAR${"a".repeat(2_000)}FAR`)
  expect(textOf(await grep({ pattern: "NEAR", path: "long.txt" }))).toBe("long.txt")
  expect(textOf(await grep({ pattern: "FAR", path: "long.txt" }))).toContain("No matches")
})

test("pathological regex times out without blocking the main thread", async () => {
  const d = await tmp.make()
  // Bun may cap one regex evaluation internally; repeated hostile lines still block the caller.
  await writeFile(join(d, "bad.txt"), `${"a".repeat(9_000)}!\n`.repeat(20))
  let ticks = 0
  const heartbeat = setInterval(() => ticks++, 20)
  const started = performance.now()
  try {
    const result = await grepTool.execute({ pattern: "(a+)+$", path: "bad.txt" }, makeCtx(d))
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("timed out")
    expect(textOf(result)).toContain("Simplify")
    expect(ticks).toBeGreaterThan(0)
    expect(performance.now() - started).toBeLessThan(4_000)
  } finally {
    clearInterval(heartbeat)
  }
}, 5_000)

test("an in-flight regex search can be aborted without affecting another search", async () => {
  const d = await tmp.make()
  await writeFile(join(d, "bad.txt"), `${"a".repeat(9_000)}!\n`.repeat(20))
  const controller = new AbortController()
  const started = performance.now()
  const pending = grepTool.execute(
    { pattern: "(a+)+$", path: "bad.txt", output_mode: "count" },
    makeCtx(d, controller.signal),
  )
  const timer = setTimeout(() => controller.abort(), 100)
  try {
    const normal = await grep({ pattern: "TODO\\b", path: "src/a.ts", output_mode: "content" })
    expect(textOf(normal)).toBe("src/a.ts:1:const TODO = 1")
    const result = await pending
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe("Aborted")
    expect(performance.now() - started).toBeLessThan(2_000)
  } finally {
    clearTimeout(timer)
  }
  // A cancelled worker must not poison later regex searches.
  expect(textOf(await grep({ pattern: "TODO.*", path: "notes.md" }))).toBe("notes.md")
})

test("worker matching preserves JavaScript regex features and all output modes", async () => {
  const d = await tmp.make()
  await writeFile(join(d, "a.txt"), "TODO TODO\r\ntodo todo\r\nTODO other\r\n")
  await writeFile(join(d, "b.txt"), "TODO TODO\n")
  const run = (params: GrepParams) => grepTool.execute(params, makeCtx(d))
  const pattern = "^(\\w+) \\1(?=$)"
  expect(textOf(await run({ pattern, ignore_case: true, output_mode: "content" }))).toBe(
    "a.txt:1:TODO TODO\na.txt:2:todo todo\nb.txt:1:TODO TODO",
  )
  expect(textOf(await run({ pattern, ignore_case: true, output_mode: "count" }))).toBe("a.txt:2\nb.txt:1")
  expect(textOf(await run({ pattern }))).toBe("a.txt\nb.txt")
  expect(textOf(await run({ pattern: "NOT.*HERE" }))).toContain("No matches")
  expect(textOf(await run({ pattern: "TODO.*", head_limit: 1 }))).toContain("Showing 1 of 2")
})

test("an already aborted search returns an error", async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await grepTool.execute({ pattern: "TODO.*" }, makeCtx(dir, controller.signal))
  expect(result.isError).toBe(true)
  expect(textOf(result)).toBe("Aborted")
})

test("worker matching retains the 10,000-character limit", async () => {
  const d = await tmp.make()
  await writeFile(join(d, "long.txt"), `${"a".repeat(9_000)}NEAR${"a".repeat(2_000)}FAR`)
  const run = (pattern: string) => grepTool.execute({ pattern, path: "long.txt" }, makeCtx(d))
  expect(textOf(await run("NEAR.*"))).toBe("long.txt")
  expect(textOf(await run("FAR.*"))).toContain("No matches")
})

test("a search over more files than one worker batch reports every file, in order", async () => {
  const d = await tmp.make()
  const names = Array.from({ length: 300 }, (_, i) => `f${String(i).padStart(3, "0")}.txt`)
  for (const name of names) await writeFile(join(d, name), "skip\r\nkeep me\r\nkeep\n")
  const run = (params: GrepParams) => grepTool.execute({ head_limit: 1000, ...params }, makeCtx(d))
  const counts = textOf(await run({ pattern: "^keep", output_mode: "count" })).split("\n")
  expect(counts).toEqual(names.map((n) => `${n}:2`))
  const rows = textOf(await run({ pattern: "^keep me$", output_mode: "content" })).split("\n")
  expect(rows).toEqual(names.map((n) => `${n}:2:keep me`))
})

test("a single-file path is searched even when glob would not match it", async () => {
  const r = await grep({ pattern: "docs", path: "notes.md", glob: "src/**/*.ts", output_mode: "content" })
  expect(textOf(r)).toBe("notes.md:1:TODO: write docs")
})

test("head_limit applies in every output mode", async () => {
  const files = textOf(await grep({ pattern: "TODO", head_limit: 1 }))
  expect(files).toStartWith("notes.md\n\n(Showing 1 of 3 results.")
  const counts = textOf(await grep({ pattern: "TODO", output_mode: "count", head_limit: 2 }))
  expect(counts).toStartWith("notes.md:1\nsrc/a.ts:1\n\n(Showing 2 of 3 results.")
  const content = textOf(await grep({ pattern: "TODO", output_mode: "content", head_limit: 3 }))
  expect(content.split("\n").slice(0, 3)).toEqual([
    "notes.md:1:TODO: write docs",
    "src/a.ts:1:const TODO = 1",
    "src/deep/b.ts:1:// TODO one",
  ])
  expect(content).toContain("(Showing 3 of 4 results.")
})

test("a ./-prefixed glob works like the plain one", async () => {
  expect(textOf(await grep({ pattern: "TODO", glob: "./src/deep/**" }))).toBe("src/deep/b.ts")
})

test("a final line break ends the last line instead of starting another, as read counts lines", async () => {
  const d = await tmp.make()
  const files: Record<string, string> = {
    "empty.txt": "",
    "none.txt": "hello",
    "lf.txt": "hello\n",
    "crlf.txt": "hello\r\n",
    "blank.txt": "\n",
    "blanks.txt": "a\n\n\nb\r\n",
  }
  for (const [name, text] of Object.entries(files)) await writeFile(join(d, name), text)
  const run = (params: GrepParams) => grepTool.execute(params, makeCtx(d))
  expect(textOf(await run({ pattern: "^$", output_mode: "content" })).split("\n")).toEqual([
    "blank.txt:1:",
    "blanks.txt:2:",
    "blanks.txt:3:",
  ])
  expect(textOf(await run({ pattern: "^", output_mode: "count" })).split("\n")).toEqual([
    "blank.txt:1",
    "blanks.txt:4",
    "crlf.txt:1",
    "lf.txt:1",
    "none.txt:1",
  ])
  expect(textOf(await run({ pattern: "^$" })).split("\n")).toEqual(["blank.txt", "blanks.txt"])
})
