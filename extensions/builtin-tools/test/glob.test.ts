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
