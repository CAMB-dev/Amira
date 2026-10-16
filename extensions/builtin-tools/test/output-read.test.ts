import { afterAll, afterEach, beforeAll, test as bunTest, expect, spyOn } from "bun:test"
import * as fs from "node:fs/promises"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ArtifactInfo, OutputStore, ToolContext, ToolSession } from "@amira/api"
import { SPAWN_TEST_TIMEOUT_MS, stopSpawn, waitForSpawnWork } from "../../../scripts/spawn-test.ts"
import { globTool } from "../src/glob.ts"
import { grepTool } from "../src/grep.ts"
import { outputReadTool } from "../src/output-read.ts"
import { TempOutputStore } from "../src/truncate.ts"
import { asyncTestScope, makeCtx, tempDirs, textOf } from "./util.ts"

const scope = asyncTestScope()
const test = (name: string, work: (signal: AbortSignal) => Promise<void>, timeout = 30_000) =>
  bunTest(name, () => scope.run(work), timeout)
afterEach(() => scope.cleanup(), 30_000)

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
}, 30_000)
afterAll(() => temps.cleanup(), 30_000)

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

  const defaultLimit = await grepTool.execute(
    { pattern: "needle", path: "tree", output_mode: "content" },
    ctxWith(store),
  )
  const defaultText = textOf(defaultLimit)
  expect(defaultText).toContain("first 250 (the default output limit)")
  expect(defaultText).not.toContain("first 250 (head_limit)")
})

test("glob saves every path when the list is long, waiting for the final write", async (signal) => {
  const many = join(dir, "many")
  await mkdir(many, { recursive: true })
  const paths = Array.from({ length: 300 }, (_, i) => `many/file-with-a-long-name-${i}.ts`)
  // Bound fixture I/O rather than queueing hundreds of writes on Windows CI.
  for (const path of paths) await writeFile(join(dir, path), "")

  const writing = Promise.withResolvers<{ id: string; path: string }>()
  const release = Promise.withResolvers<void>()
  const original = fs.writeFile
  const spy = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    const [path, text] = args
    if (typeof path === "string" && path.endsWith(".txt.tmp") && typeof text === "string") {
      // Leave exactly the last path unwritten until the test releases the writer.
      await original(path, text.slice(0, text.lastIndexOf("\n")))
      writing.resolve({ id: path.split(/[\\/]/).at(-1)!.slice(0, -8), path })
      await release.promise
    }
    return original(...args)
  })
  const abort = () => {
    release.resolve()
    writing.reject(new Error("artifact write aborted"))
  }
  signal.addEventListener("abort", abort, { once: true })
  let settled = false
  const work = globTool
    .execute({ pattern: "**/*.ts", path: "many" }, { ...ctxWith(store), signal })
    .finally(() => {
      settled = true
    })
  try {
    const partial = await Promise.race([
      writing.promise,
      work.then(() => {
        throw new Error("glob returned before writing an artifact")
      }),
    ])
    expect((await readFile(partial.path, "utf8")).split("\n")).toHaveLength(299)
    expect(settled).toBe(false)
    expect(store.find(partial.id)).toBeUndefined()
    expect((await run({ id: partial.id })).isError).toBe(true)
    release.resolve()
    const r = await work
    const d = r.details as { artifact?: string; count: number; fullOutputPath?: string }
    expect(d.count).toBe(300)
    expect(d.artifact).toBe(partial.id)
    const saved = (await readFile(d.fullOutputPath!, "utf8")).split("\n")
    expect([...saved].sort()).toEqual([...paths].sort())
    expect(store.find(d.artifact!)).toMatchObject({ lines: 300, complete: true })
    expect(textOf(await run({ id: d.artifact!, offset: 300 }))).toContain(`   300\t${saved[299]}`)
    expect(textOf(r)).toContain("300 files, newest first")
  } finally {
    release.resolve()
    await work.catch(() => {})
    spy.mockRestore()
    signal.removeEventListener("abort", abort)
  }
})

test(
  "a timed-out output test drains its save without leaking a late rejection to the next test",
  async () => {
    const fixture = await temps.make()
    const source = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href)
    await writeFile(
      join(fixture, "bunfig.toml"),
      `[test]\npreload = [${JSON.stringify(fileURLToPath(new URL("../../../scripts/test-env.ts", import.meta.url)))}]\n`,
    )
    await writeFile(
      join(fixture, "timeout.test.ts"),
      `import { afterEach, expect, test } from "bun:test"
import { TempOutputStore } from ${source("../src/truncate.ts")}
import { asyncTestScope } from ${source("./util.ts")}
const scope = asyncTestScope()
const gate = Promise.withResolvers()
const store = new TempOutputStore("artifacts", { saveAbove: 1 })
let saved = false
afterEach(() => scope.cleanup(), 30_000)
test("blocked save", () => scope.run(async (signal) => {
  signal.addEventListener("abort", () => gate.resolve(), { once: true })
  await gate.promise
  await store.save({ text: "first path\\nlast path", tool: "glob" })
  saved = true
  throw new Error("late output failure")
}), 20)
test("next test sees the save drained", () => expect(saved).toBe(true))
`,
    )
    const child = Bun.spawn([process.execPath, "test", "./timeout.test.ts"], {
      cwd: fixture,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    try {
      const [code, stdout, stderr] = await waitForSpawnWork(
        "output timeout fixture",
        Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
      )
      expect(code).toBe(1)
      const output = stdout + stderr
      expect(output).toContain("timed out after 20ms")
      expect(output).toContain("1 pass")
      expect(output).toContain("1 fail")
      expect(output).not.toContain("Unhandled error between tests")
      expect(output).not.toContain("late output failure")
    } finally {
      await stopSpawn(child)
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
