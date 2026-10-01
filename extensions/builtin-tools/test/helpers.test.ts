import { afterAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { isBinary, walkFiles } from "../src/files.ts"
import { displayPath, OUTSIDE_WORKING_DIRECTORY, resolvePath } from "../src/paths.ts"
import { keepOutput, TempOutputStore } from "../src/truncate.ts"
import { makeCtx } from "./util.ts"

const ctx = makeCtx(tmpdir())
/** Outputs over 1000 characters are saved; previews are about 1000 characters. */
async function keep(text: string, dir?: string) {
  const store = new TempOutputStore(dir ?? (await mkdtemp(join(tmpdir(), "amira-keep-"))), {
    saveAbove: 1000,
    previewChars: 1000,
  })
  dirs.push(store.dir)
  return keepOutput(ctx, { text, tool: "t", store })
}

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

test("short output is returned unchanged", async () => {
  expect(await keep("hello")).toEqual({ text: "hello" })
  // Exactly at the limit is not over it.
  expect((await keep("x".repeat(1000))).artifact).toBeUndefined()
})

test("CJK output counts four to a character against the limit", async () => {
  // 300 CJK characters take about as many tokens as 1200 ASCII ones: over the 1000 limit.
  const r = await keep("编".repeat(300))
  expect(r.artifact).toBeDefined()
  expect((await keep("x".repeat(300))).artifact).toBeUndefined()
})

test("long output is saved whole and previewed by its head and tail", async () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`)
  const full = lines.join("\n")
  const r = await keep(full)
  expect(r.artifact).toBeDefined()
  const [header, ...rest] = r.text.split("\n")
  expect(header).toStartWith(`[Output saved as artifact ${r.artifact!.id}: `)
  expect(header).toContain("5,000 lines")
  expect(header).toContain(r.artifact!.path)
  expect(rest[0]).toBe("line 0")
  expect(r.text.endsWith("line 4999")).toBe(true)
  expect(r.text).toMatch(/\[\.\.\. [\d,]+ lines \([\d,]+ characters\) omitted: lines \d+-\d+ \.\.\.\]/)
  expect(r.text.length).toBeLessThan(1400)
  expect(await readFile(r.artifact!.path, "utf8")).toBe(full)
})

test("isBinary detects NUL bytes", () => {
  expect(isBinary(new TextEncoder().encode("plain text"))).toBe(false)
  expect(isBinary(new Uint8Array([72, 0, 73]))).toBe(true)
})

test("walkFiles skips .git and node_modules and yields forward-slash paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "amira-walk-"))
  dirs.push(root)
  for (const d of ["a/b", ".git", "node_modules/x"]) await mkdir(join(root, d), { recursive: true })
  for (const f of ["z.txt", "a/one.ts", "a/b/two.ts", ".git/HEAD", "node_modules/x/i.js"]) {
    await writeFile(join(root, f), f)
  }
  const seen: string[] = []
  for await (const e of walkFiles(root)) seen.push(e.rel)
  expect(seen.sort()).toEqual(["a/b/two.ts", "a/one.ts", "z.txt"])
})

test("walkFiles honors repository ignore files and skips nested repositories", async () => {
  const root = await mkdtemp(join(tmpdir(), "amira-walk-ignore-"))
  dirs.push(root)
  await mkdir(join(root, ".git", "info"), { recursive: true })
  await mkdir(join(root, "src", "nested"), { recursive: true })
  await mkdir(join(root, "nested-repo", ".git"), { recursive: true })
  await mkdir(join(root, "linked-repo"), { recursive: true })
  await writeFile(join(root, ".gitignore"), "ignored.txt\n*.ignored\n/cache/\n")
  await writeFile(join(root, ".git", "info", "exclude"), "excluded.txt\n")
  await writeFile(join(root, "src", ".gitignore"), "local.txt\n")
  for (const file of [
    "kept.txt",
    "ignored.txt",
    "excluded.txt",
    "bad.ignored",
    "cache/drop.txt",
    "src/local.txt",
    "src/kept.ts",
    "nested-repo/hidden.ts",
    "linked-repo/hidden.ts",
  ]) {
    const target = join(root, file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file)
  }
  await writeFile(join(root, "linked-repo", ".git"), "gitdir: elsewhere\n")
  const globalIgnore = join(root, "global-ignore")
  const globalConfig = join(root, "global-gitconfig")
  await writeFile(globalIgnore, "*.global\n")
  await writeFile(globalConfig, `[core]\n\texcludesFile = ${globalIgnore}\n`)
  await writeFile(join(root, "global.global"), "global.global")
  const oldGlobalConfig = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  try {
    const seen: string[] = []
    for await (const entry of walkFiles(root)) seen.push(entry.rel)
    expect(seen.sort()).toEqual([
      ".gitignore",
      "global-gitconfig",
      "global-ignore",
      "kept.txt",
      "src/.gitignore",
      "src/kept.ts",
    ])
  } finally {
    if (oldGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = oldGlobalConfig
  }
})

test("displayPath is relative inside cwd and marks absolute paths outside", () => {
  const cwd = join(tmpdir(), "proj")
  expect(displayPath(cwd, join(cwd, "src", "a.ts"))).toBe("src/a.ts")
  const outside = join(tmpdir(), "other", "b.ts")
  expect(displayPath(cwd, outside)).toBe(`${OUTSIDE_WORKING_DIRECTORY} ${outside.replaceAll("\\", "/")}`)
})

const isWindows = process.platform === "win32"

test("resolvePath expands ~ to the home directory", () => {
  expect(resolvePath(tmpdir(), "~")).toBe(homedir())
  expect(resolvePath(tmpdir(), "~/x/y")).toBe(join(homedir(), "x", "y"))
  expect(resolvePath(tmpdir(), "~x")).toBe(join(tmpdir(), "~x"))
})

test.if(isWindows)("resolvePath maps MSYS drive and /tmp paths on Windows", () => {
  const cwd = "E:/work"
  expect(resolvePath(cwd, "/d/dev/x")).toBe(join("D:/", "dev", "x"))
  expect(resolvePath(cwd, "/c")).toBe("C:/".replaceAll("/", sep))
  expect(resolvePath(cwd, "/tmp/x")).toBe(join(tmpdir(), "x"))
  expect(resolvePath(cwd, "/tmpfile")).toBe(resolve("/tmpfile"))
  expect(resolvePath(cwd, "D:/dev/x")).toBe(join("D:/", "dev", "x"))
  expect(resolvePath(cwd, "//server/share/dir/f.txt")).toBe(
    ["", "", "server", "share", "dir", "f.txt"].join(sep),
  )
})

test("truncates without a file when the output directory is unwritable", async () => {
  const root = await mkdtemp(join(tmpdir(), "amira-trunc-"))
  dirs.push(root)
  const blocker = join(root, "not-a-dir")
  await writeFile(blocker, "x")
  const full = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n")
  const r = await keep(full, join(blocker, "out"))
  expect(r.artifact).toBeUndefined()
  expect(r.text).toStartWith("[Output too long: ")
  expect(r.text).toContain("could not be saved")
  expect(r.text).not.toContain("output_read")
  expect(r.text.split("\n")[1]).toBe("line 0")
  expect(r.text).toEndWith("line 1999")
})

test("deletes saved outputs older than a day the first time it saves", async () => {
  const out = await mkdtemp(join(tmpdir(), "amira-sweep-"))
  dirs.push(out)
  const old = join(out, "old.txt")
  const fresh = join(out, "fresh.txt")
  await writeFile(old, "old")
  await writeFile(fresh, "fresh")
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  await utimes(old, twoDaysAgo, twoDaysAgo)
  const r = await keep("x\n".repeat(1000), out)
  expect(r.artifact).toBeDefined()
  for (let i = 0; i < 50 && existsSync(old); i++) await Bun.sleep(20)
  expect(existsSync(old)).toBe(false)
  expect(existsSync(fresh)).toBe(true)
})

test("write and edit order calls to the same file, case-insensitively where paths are", async () => {
  const { writeTool } = await import("../src/write.ts")
  const { editTool } = await import("../src/edit.ts")
  const cwd = process.cwd()
  const a = writeTool.concurrencyKey?.({ path: "x/File.ts", content: "" }, { cwd })
  const b = editTool.concurrencyKey?.({ path: `${cwd}/x/File.ts`, old_string: "", new_string: "" }, { cwd })
  expect(a).toBeDefined()
  expect(a).toBe(b)
  if (process.platform === "win32") {
    expect(writeTool.concurrencyKey?.({ path: "X/file.TS", content: "" }, { cwd })).toBe(a)
  }
})
