import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { editTool } from "../src/edit.ts"
import { grepTool } from "../src/grep.ts"
import { readTool } from "../src/read.ts"
import { makeCtx, tempDirs, textOf } from "./util.ts"

const tmp = tempDirs()
let dir: string
beforeAll(async () => {
  dir = await tmp.make()
})
afterAll(() => tmp.cleanup())

// "café\nfoo\n" in Windows-1252: 0xE9 is not valid UTF-8.
const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x66, 0x6f, 0x6f, 0x0a])

const BOM = String.fromCharCode(0xfeff)
const REPLACEMENT = String.fromCharCode(0xfffd)
const utf16be = (s: string) => Buffer.from(s, "utf16le").swap16()

test("edit refuses a file that is not valid UTF-8 and leaves it untouched", async () => {
  await writeFile(join(dir, "latin.txt"), latin1)
  const r = await editTool.execute({ path: "latin.txt", old_string: "foo", new_string: "bar" }, makeCtx(dir))
  expect(r.isError).toBe(true)
  expect(textOf(r)).toContain("not valid UTF-8 (invalid byte at offset 3")
  expect(textOf(r)).toContain("edit refused to avoid corrupting it")
  expect(await readFile(join(dir, "latin.txt"))).toEqual(latin1)
})

test("read shows a file that is not valid UTF-8 with a warning", async () => {
  await writeFile(join(dir, "latin-r.txt"), latin1)
  const text = textOf(await readTool.execute({ path: "latin-r.txt" }, makeCtx(dir)))
  expect(text).toStartWith(`     1\tcaf${REPLACEMENT}\n     2\tfoo`)
  expect(text).toContain("not valid UTF-8")
})

test("grep still searches a file that is not valid UTF-8", async () => {
  await writeFile(join(dir, "latin-g.txt"), latin1)
  const r = await grepTool.execute(
    { pattern: "foo", path: "latin-g.txt", output_mode: "content" },
    makeCtx(dir),
  )
  expect(textOf(r)).toBe("latin-g.txt:2:foo")
})

test("read and grep decode UTF-16 with a BOM", async () => {
  await writeFile(join(dir, "le.txt"), Buffer.from(`${BOM}hello\r\nwörld\r\n`, "utf16le"))
  await writeFile(join(dir, "be.txt"), utf16be(`${BOM}hello\nwörld\n`))
  for (const path of ["le.txt", "be.txt"]) {
    const r = await readTool.execute({ path }, makeCtx(dir))
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toBe("     1\thello\n     2\twörld")
    const g = await grepTool.execute({ pattern: "wör", path, output_mode: "content" }, makeCtx(dir))
    expect(textOf(g)).toBe(`${path}:2:wörld`)
  }
})

test("edit keeps UTF-16 encoding, BOM and line endings", async () => {
  await writeFile(join(dir, "le-e.txt"), Buffer.from(`${BOM}one\r\ntwo\r\n`, "utf16le"))
  await writeFile(join(dir, "be-e.txt"), utf16be(`${BOM}one\ntwo\n`))
  const le = await editTool.execute(
    { path: "le-e.txt", old_string: "two\n", new_string: "zwei\ndrei\n" },
    makeCtx(dir),
  )
  expect(le.isError).toBeUndefined()
  expect(await readFile(join(dir, "le-e.txt"))).toEqual(
    Buffer.from(`${BOM}one\r\nzwei\r\ndrei\r\n`, "utf16le"),
  )
  const be = await editTool.execute({ path: "be-e.txt", old_string: "one", new_string: "eins" }, makeCtx(dir))
  expect(be.isError).toBeUndefined()
  expect(await readFile(join(dir, "be-e.txt"))).toEqual(utf16be(`${BOM}eins\ntwo\n`))
})

test("edit keeps a UTF-8 BOM and matches text right after it", async () => {
  await writeFile(join(dir, "bom.txt"), `${BOM}first\nsecond\n`)
  const r = await editTool.execute(
    { path: "bom.txt", old_string: "first\nsecond", new_string: "1\n2" },
    makeCtx(dir),
  )
  expect(r.isError).toBeUndefined()
  expect(await readFile(join(dir, "bom.txt"), "utf8")).toBe(`${BOM}1\n2\n`)
})
