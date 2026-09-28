import { afterAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { isBinary, walkFiles } from "../src/files.ts"
import { displayPath, resolvePath } from "../src/paths.ts"
import { truncateOutput } from "../src/truncate.ts"

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

test("short output is returned unchanged", async () => {
  expect(await truncateOutput("hello", "t")).toEqual({ text: "hello" })
})

test("long output keeps head and tail and saves the full text", async () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`)
  const full = lines.join("\n")
  const r = await truncateOutput(full, "t", 1000)
  expect(r.fullOutputPath).toBeDefined()
  expect(r.text.startsWith("line 0\n")).toBe(true)
  expect(r.text.endsWith("line 4999")).toBe(true)
  expect(r.text).toContain(r.fullOutputPath!)
  expect(r.text.length).toBeLessThan(1400)
  expect(await readFile(r.fullOutputPath!, "utf8")).toBe(full)
  await rm(r.fullOutputPath!)
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

test("displayPath is relative inside cwd and absolute outside", () => {
  const cwd = join(tmpdir(), "proj")
  expect(displayPath(cwd, join(cwd, "src", "a.ts"))).toBe("src/a.ts")
  const outside = join(tmpdir(), "other", "b.ts")
  expect(displayPath(cwd, outside)).toBe(outside.replaceAll("\\", "/"))
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
