import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { globTool } from "../src/glob.ts"
import { makeCtx, tempDirs, textOf } from "./util.ts"

const tmp = tempDirs()
let dir: string
beforeAll(async () => {
  dir = await tmp.make()
  for (const d of ["src/lib", "node_modules/pkg", ".git"]) await mkdir(join(dir, d), { recursive: true })
  const files = ["old.ts", "src/a.ts", "src/lib/b.ts", "src/c.js", "node_modules/pkg/i.ts", ".git/x.ts"]
  for (const [i, f] of files.entries()) {
    await writeFile(join(dir, f), f)
    const t = new Date(Date.UTC(2020, 0, 1 + i))
    await utimes(join(dir, f), t, t)
  }
})
afterAll(() => tmp.cleanup())

const glob = (pattern: string, path?: string) => globTool.execute({ pattern, path }, makeCtx(dir))

test("matches recursively, newest first, skipping .git and node_modules", async () => {
  expect(textOf(await glob("**/*.ts")).split("\n")).toEqual(["src/lib/b.ts", "src/a.ts", "old.ts"])
})

test("a pattern without ** only matches the top level", async () => {
  expect(textOf(await glob("*.ts"))).toBe("old.ts")
})

test("searches under path and prints paths relative to cwd", async () => {
  expect(textOf(await glob("*.{js,ts}", "src")).split("\n")).toEqual(["src/c.js", "src/a.ts"])
})

test("reports no matches and missing directories", async () => {
  const none = await glob("**/*.rs")
  expect(none.isError).toBeUndefined()
  expect(textOf(none)).toContain("No files matched")
  expect((await glob("*", "missing")).isError).toBe(true)
})

test("reports cancellation instead of no matches when the walk stops", async () => {
  let checks = 0
  const signal = {
    get aborted() {
      return ++checks > 2
    },
  } as AbortSignal
  const result = await globTool.execute({ pattern: "**/*.does-not-exist" }, makeCtx(dir, signal))
  expect(result.isError).toBe(true)
  expect(textOf(result)).toBe("Aborted")
})

test("accepts ./-prefixed, ../ and absolute patterns", async () => {
  expect(textOf(await glob("./src/**/*.ts")).split("\n")).toEqual(["src/lib/b.ts", "src/a.ts"])
  expect(textOf(await glob("../lib/*.ts", "src/lib/../lib/../lib"))).toBe("src/lib/b.ts")
  const abs = `${dir.replaceAll("\\", "/")}/src/**/*.js`
  expect(textOf(await glob(abs))).toBe("src/c.js")
  expect(textOf(await glob(`${dir}/old.ts`))).toBe("old.ts")
})

test("a wildcard-free parent or home pattern lists that directory instead of walking the drive", async () => {
  const started = performance.now()
  const up = textOf(await globTool.execute({ pattern: ".." }, makeCtx(join(dir, "src", "lib"))))
  // Paths outside cwd remain absolute and carry an explicit marker.
  const names = up.split("\n").map((p) => p.split("/").slice(-2).join("/"))
  expect(names.sort()).toEqual(["src/a.ts", "src/c.js"])
  expect(performance.now() - started).toBeLessThan(2000)
  const one = textOf(await globTool.execute({ pattern: "../a.ts" }, makeCtx(join(dir, "src", "lib"))))
  expect(one).toContain("[outside working directory]")
  expect(one.endsWith("/src/a.ts")).toBe(true)
})
