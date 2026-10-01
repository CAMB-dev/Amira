import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ArtifactInfo, OutputStore, ToolContext, ToolSession } from "@amira/api"
import { globTool } from "../src/glob.ts"
import { grepTool } from "../src/grep.ts"
import { outputReadTool } from "../src/output-read.ts"
import { TempOutputStore } from "../src/truncate.ts"
import { makeCtx, tempDirs, textOf } from "./util.ts"

const temps = tempDirs()
let dir: string
let store: TempOutputStore

/** A call context whose session saves artifacts in `store`. */
function ctxWith(outputs: OutputStore, cwd = dir): ToolContext {
  return { ...makeCtx(cwd), session: { outputs } as unknown as ToolSession }
}

beforeAll(async () => {
  dir = await temps.make()
  store = new TempOutputStore(join(dir, "artifacts"), { saveAbove: 2000, previewChars: 1000 })
})
afterAll(() => temps.cleanup())

const run = (args: Parameters<typeof outputReadTool.execute>[0], outputs: OutputStore = store) =>
  outputReadTool.execute(args, ctxWith(outputs))

test("reads a range of an artifact's lines, numbered, with where to go on", async () => {
  const a = await store.save({ text: "alpha\r\nbeta\r\ngamma\r\ndelta\r\n", tool: "bash" })
  const r = textOf(await run({ id: a.id, offset: 2, limit: 2 }))
  expect(r).toStartWith(`Artifact ${a.id} (bash, 4 lines, `)
  expect(r).toContain("     2\tbeta\n     3\tgamma")
  expect(r).not.toContain("\r")
  expect(r).toContain("Use offset=4 to read more.")
  expect(textOf(await run({ id: a.id }))).not.toContain("read more")
  const past = await run({ id: a.id, offset: 9 })
  expect(past.isError).toBe(true)
  expect(textOf(past)).toContain("past the end (4 lines)")
})

test("greps an artifact, case-insensitively when asked, from an offset on", async () => {
  const text = Array.from({ length: 500 }, (_, i) =>
    i % 50 === 0 ? `ERROR at ${i + 1}` : `ok ${i + 1}`,
  ).join("\n")
  const a = await store.save({ text, tool: "bash" })
  const r = textOf(await run({ id: a.id, grep: "error", ignore_case: true, limit: 3 }))
  expect(r).toContain("     1\tERROR at 1\n    51\tERROR at 51\n   101\tERROR at 101")
  expect(r).toContain("(10 matching lines. Showing the first 3; use offset=102 to continue.)")
  expect(textOf(await run({ id: a.id, grep: "error" }))).toContain("no lines from line 1 on match /error/")
  expect(textOf(await run({ id: a.id, grep: "ERROR", offset: 450 }))).toContain("(1 matching lines.)")
  expect((await run({ id: a.id, grep: "(" })).isError).toBe(true)
})

test("a long line is cut, and column pages through it", async () => {
  const line = `${"a".repeat(2000)}${"b".repeat(2000)}${"c".repeat(100)}`
  const a = await store.save({ text: line, tool: "bash" })
  const first = textOf(await run({ id: a.id }))
  expect(first).toContain(`${"a".repeat(2000)}… [2,100 more characters; column=2001 continues]`)
  const second = textOf(await run({ id: a.id, column: 2001 }))
  expect(second).toContain(`\t${"b".repeat(2000)}… [100 more characters; column=4001 continues]`)
  expect(textOf(await run({ id: a.id, column: 4001 }))).toContain(`\t${"c".repeat(100)}`)
})

test("output stays under the size limit for large outputs", async () => {
  const a = await store.save({
    text: Array.from({ length: 1000 }, (_, i) => `row ${i}`).join("\n"),
    tool: "t",
  })
  const r = textOf(await run({ id: a.id, limit: 1000 }))
  expect(r.length).toBeLessThan(2000)
  expect(r).toMatch(/Use offset=\d+ to read more\.\)$/)
})

test("unknown, pruned and missing artifacts are clear errors", async () => {
  const unknown = await run({ id: "a_9999999999" })
  expect(unknown.isError).toBe(true)
  expect(textOf(unknown)).toContain("No artifact a_9999999999 in this session")
  const gone = await store.save({ text: "x", tool: "t" })
  await rm(gone.path)
  expect(textOf(await run({ id: gone.id }))).toContain("its file was moved or deleted")
  const pruned: OutputStore = {
    limits: store.limits,
    save: () => Promise.reject(new Error("no")),
    find: (id) => ({ ...(store.find(gone.id) as ArtifactInfo), id, pruned: "2026-10-01T00:00:00.000Z" }),
  }
  const p = await run({ id: "a_1234567890" }, pruned)
  expect(p.isError).toBe(true)
  expect(textOf(p)).toContain("was deleted with /prune")
  expect((await run({ id: "x", offset: 0 })).isError).toBe(true)
})

test("grep saves all its results before head_limit cuts them; the preview is cut from the shown ones", async () => {
  const tree = join(dir, "tree")
  await mkdir(tree, { recursive: true })
  for (let i = 0; i < 40; i++) {
    await writeFile(
      join(tree, `f${i}.txt`),
      Array.from({ length: 30 }, (_, j) => `needle ${i}-${j}`).join("\n"),
    )
  }
  const r = await grepTool.execute(
    { pattern: "needle", path: "tree", output_mode: "content", head_limit: 10 },
    ctxWith(store),
  )
  const d = r.details as { artifact?: string; total: number; fullOutputPath?: string }
  expect(d.total).toBe(1200)
  expect(d.artifact).toBeDefined()
  const saved = await readFile(d.fullOutputPath!, "utf8")
  expect(saved.split("\n")).toHaveLength(1200)
  const text = textOf(r)
  expect(text).toStartWith(`[Output saved as artifact ${d.artifact}: `)
  expect(text).toContain(
    "1200 results; the preview is cut from the first 10 (head_limit), the artifact has all of them",
  )
  expect(text.split("\n").slice(1)).toHaveLength(10)
  // Under the limit, results stay as before: shown up to head_limit, with the note.
  const few = await grepTool.execute(
    { pattern: "needle 1-", path: "tree", output_mode: "content", head_limit: 5 },
    ctxWith(store),
  )
  expect((few.details as { artifact?: string }).artifact).toBeUndefined()
  expect(textOf(few)).toContain("(Showing 5 of")
})

test("glob saves every path when the list is long", async () => {
  const many = join(dir, "many")
  await mkdir(many, { recursive: true })
  await Promise.all(
    Array.from({ length: 300 }, (_, i) => writeFile(join(many, `file-with-a-long-name-${i}.ts`), "")),
  )
  const r = await globTool.execute({ pattern: "**/*.ts", path: "many" }, ctxWith(store))
  const d = r.details as { artifact?: string; count: number; fullOutputPath?: string }
  expect(d.count).toBe(300)
  expect(d.artifact).toBeDefined()
  expect((await readFile(d.fullOutputPath!, "utf8")).split("\n")).toHaveLength(300)
  expect(textOf(r)).toContain("300 files, newest first")
})
