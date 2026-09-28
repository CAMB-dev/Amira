import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { editTool } from "../src/edit.ts"
import { writeTool } from "../src/write.ts"
import { makeCtx, tempDirs, textOf } from "./util.ts"

const tmp = tempDirs()
let dir: string
beforeAll(async () => {
  dir = await tmp.make()
})
afterAll(() => tmp.cleanup())

const edit = (params: Parameters<typeof editTool.execute>[0]) => editTool.execute(params, makeCtx(dir))

test("write creates parent directories and summarizes", async () => {
  const r = await writeTool.execute({ path: "deep/nested/f.txt", content: "a\nb\n" }, makeCtx(dir))
  expect(r.isError).toBeUndefined()
  expect(textOf(r)).toBe("Created deep/nested/f.txt (2 lines, 4 bytes)")
  expect(await readFile(join(dir, "deep/nested/f.txt"), "utf8")).toBe("a\nb\n")
  const again = await writeTool.execute({ path: join(dir, "deep/nested/f.txt"), content: "x" }, makeCtx(dir))
  expect(textOf(again)).toStartWith("Overwrote")
})

test("write refuses to replace a directory", async () => {
  const r = await writeTool.execute({ path: "deep", content: "x" }, makeCtx(dir))
  expect(r.isError).toBe(true)
})

test("edit replaces a unique match", async () => {
  await writeFile(join(dir, "e.ts"), "const a = 1\nconst b = 2\n")
  const r = await edit({ path: "e.ts", old_string: "const b = 2", new_string: "const b = $&3" })
  expect(r.isError).toBeUndefined()
  expect(await readFile(join(dir, "e.ts"), "utf8")).toBe("const a = 1\nconst b = $&3\n")
})

test("edit reports the match count when not unique, and replace_all replaces all", async () => {
  await writeFile(join(dir, "m.txt"), "foo bar foo baz foo")
  const r = await edit({ path: "m.txt", old_string: "foo", new_string: "qux" })
  expect(r.isError).toBe(true)
  expect(textOf(r)).toContain("3 times")
  const all = await edit({ path: "m.txt", old_string: "foo", new_string: "qux", replace_all: true })
  expect(textOf(all)).toContain("3 occurrences")
  expect(await readFile(join(dir, "m.txt"), "utf8")).toBe("qux bar qux baz qux")
})

test("edit errors on no match, identical strings and missing files", async () => {
  await writeFile(join(dir, "n.txt"), "hello")
  const none = await edit({ path: "n.txt", old_string: "absent", new_string: "x" })
  expect(none.isError).toBe(true)
  expect(textOf(none)).toContain("0 matches")
  expect((await edit({ path: "n.txt", old_string: "hello", new_string: "hello" })).isError).toBe(true)
  expect((await edit({ path: "nope.txt", old_string: "a", new_string: "b" })).isError).toBe(true)
  expect((await edit({ path: "n.txt", old_string: "", new_string: "b" })).isError).toBe(true)
})

test("edit preserves CRLF line endings", async () => {
  await writeFile(join(dir, "crlf.txt"), "one\r\ntwo\r\nthree\r\n")
  const r = await edit({ path: "crlf.txt", old_string: "one\ntwo\n", new_string: "1\n2\n2.5\n" })
  expect(r.isError).toBeUndefined()
  expect(await readFile(join(dir, "crlf.txt"), "utf8")).toBe("1\r\n2\r\n2.5\r\nthree\r\n")
})
