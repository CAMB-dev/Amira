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

test("edit and write put the change as diff hunks in details, not in the result text", async () => {
  await writeFile(join(dir, "d.ts"), "one\ntwo\nthree\n")
  const r = await edit({ path: "d.ts", old_string: "two", new_string: "2\n2b" })
  expect(textOf(r)).toBe("Edited d.ts: replaced 1 occurrence")
  expect(r.details).toMatchObject({
    path: join(dir, "d.ts"),
    replacements: 1,
    added: 2,
    removed: 1,
    hunks: [{ oldStart: 1, newStart: 1, lines: [" one", "-two", "+2", "+2b", " three"] }],
  })
  const w = await writeTool.execute({ path: "d.ts", content: "one\n2\nthree\n" }, makeCtx(dir))
  expect(w.details).toMatchObject({
    created: false,
    added: 0,
    removed: 1,
    hunks: [{ lines: expect.any(Array) }],
  })
  const n = await writeTool.execute({ path: "new.ts", content: "a\nb\n" }, makeCtx(dir))
  expect(n.details).toMatchObject({ created: true, added: 2, removed: 0 })
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

test("edit matches in files with mixed line endings and keeps each region's style", async () => {
  await writeFile(join(dir, "mixed.txt"), "a\r\nb\r\nc\nd\ne\n")
  expect(
    (await edit({ path: "mixed.txt", old_string: "c\nd\n", new_string: "C\nD\nD2\n" })).isError,
  ).toBeUndefined()
  expect((await edit({ path: "mixed.txt", old_string: "a\nb", new_string: "A\nB" })).isError).toBeUndefined()
  expect(await readFile(join(dir, "mixed.txt"), "utf8")).toBe("A\r\nB\r\nC\nD\nD2\ne\n")
})

test("edit accepts an old_string written with CRLF against an LF file", async () => {
  await writeFile(join(dir, "lf.txt"), "one\ntwo\nthree\n")
  const r = await edit({ path: "lf.txt", old_string: "one\r\ntwo\r\n", new_string: "1\r\n2\r\n" })
  expect(r.isError).toBeUndefined()
  expect(await readFile(join(dir, "lf.txt"), "utf8")).toBe("1\n2\nthree\n")
})

test("a multi-line new_string follows the file's line endings when old_string has none", async () => {
  await writeFile(join(dir, "crlf2.txt"), "x = 1\r\ny = 2\r\n")
  expect(
    (await edit({ path: "crlf2.txt", old_string: "y = 2", new_string: "y = 2\nz = 3" })).isError,
  ).toBeUndefined()
  expect(await readFile(join(dir, "crlf2.txt"), "utf8")).toBe("x = 1\r\ny = 2\r\nz = 3\r\n")
})

test("write says so when a parent path is a file", async () => {
  await writeFile(join(dir, "plain.txt"), "x")
  const r = await writeTool.execute({ path: "plain.txt/sub/f.txt", content: "y" }, makeCtx(dir))
  expect(r.isError).toBe(true)
  expect(textOf(r)).toContain(`${join(dir, "plain.txt")} is a file, not a directory`)
})
