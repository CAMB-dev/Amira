import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { MAX_IMAGE_BYTES, readTool } from "../src/read.ts"
import { makeCtx, tempDirs, textOf } from "./util.ts"

const tmp = tempDirs()
let dir: string
beforeAll(async () => {
  dir = await tmp.make()
})
afterAll(() => tmp.cleanup())

const read = (params: Parameters<typeof readTool.execute>[0], signal?: AbortSignal) =>
  readTool.execute(params, makeCtx(dir, signal))

test("numbers lines like cat -n and resolves relative paths", async () => {
  await writeFile(join(dir, "a.txt"), "alpha\r\nbeta\ngamma\n")
  const r = await read({ path: "a.txt" })
  expect(r.isError).toBeUndefined()
  expect(textOf(r)).toBe("     1\talpha\n     2\tbeta\n     3\tgamma")
})

test("offset and limit select a range and hint at the next offset", async () => {
  const text = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n")
  await writeFile(join(dir, "ten.txt"), text)
  const r = textOf(await read({ path: join(dir, "ten.txt"), offset: 3, limit: 2 }))
  expect(r).toStartWith("     3\tl3\n     4\tl4\n")
  expect(r).toContain("offset=5")
  expect(textOf(await read({ path: "ten.txt", offset: 50 }))).toContain("past the end")
})

test("defaults to 2000 lines and truncates long lines", async () => {
  const lines = Array.from({ length: 2500 }, (_, i) => String(i + 1))
  lines[0] = "x".repeat(5000)
  await writeFile(join(dir, "big.txt"), lines.join("\n"))
  const out = textOf(await read({ path: "big.txt" }))
  expect(out).toContain("[line truncated]")
  expect(out).not.toContain("x".repeat(2001))
  expect(out).toContain("  2000\t2000")
  expect(out).not.toContain("  2001\t2001")
  expect(out).toContain("offset=2001")
})

test("returns images as base64 image blocks", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  await writeFile(join(dir, "pic.PNG"), png)
  const r = await read({ path: "pic.PNG" })
  expect(r.content[0]).toEqual({
    type: "image",
    mimeType: "image/png",
    data: Buffer.from(png).toString("base64"),
  })
})

test("streams large files: a window deep in the file, and a huge single line", async () => {
  const line = (i: number) => `${String(i).padStart(7, "0")} é ${"x".repeat(90)}`
  const lines = Array.from({ length: 300_000 }, (_, i) => line(i + 1))
  await writeFile(join(dir, "large.log"), `${lines.join("\n")}\n`)
  const r = textOf(await read({ path: "large.log", offset: 299_998, limit: 2 }))
  expect(r).toBe(
    `299998\t${line(299_998)}\n299999\t${line(299_999)}\n\n(Showing lines 299998-299999. Use offset=300000 to read more.)`,
  )
  expect(textOf(await read({ path: "large.log", offset: 300_000 }))).toBe(`300000\t${line(300_000)}`)
  expect(textOf(await read({ path: "large.log", offset: 300_001 }))).toContain("which has 300000 lines")

  await writeFile(join(dir, "one-line.min.js"), "y".repeat(20_000_000))
  const one = textOf(await read({ path: "one-line.min.js" }))
  expect(one).toStartWith(`     1\t${"y".repeat(2000)}… [line truncated]`)
  expect(one.length).toBeLessThan(2100)
})

test("reports the total line count for small files", async () => {
  await writeFile(join(dir, "five.txt"), "1\n2\n3\n4\n5")
  expect(textOf(await read({ path: "five.txt", limit: 2 }))).toContain(
    "(Showing lines 1-2 of 5. Use offset=3",
  )
})

test("refuses images over the size cap and says how big they are", async () => {
  await writeFile(join(dir, "huge.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1024 * 1024, 1))
  const r = await read({ path: "huge.png" })
  expect(r.isError).toBe(true)
  expect(textOf(r)).toContain("image of 6 MB, over the 5 MB limit")
})

test("errors on missing files, directories and binary files", async () => {
  await mkdir(join(dir, "sub"))
  await writeFile(join(dir, "blob.bin"), new Uint8Array([1, 2, 0, 3]))
  for (const path of ["missing.txt", "sub", "blob.bin"]) {
    const r = await read({ path })
    expect(r.isError).toBe(true)
  }
  expect(textOf(await read({ path: "missing.txt" }))).toContain("not found")
})

test("honors an aborted signal", async () => {
  const ac = new AbortController()
  ac.abort()
  expect((await read({ path: "a.txt" }, ac.signal)).isError).toBe(true)
})

test("rejects offsets and limits that are not whole numbers of at least 1", async () => {
  await writeFile(join(dir, "three.txt"), "1\n2\n3\n")
  const bad: Record<string, unknown>[] = [
    { offset: Number.NaN },
    { offset: 1.5 },
    { offset: 0 },
    { offset: -2 },
    { offset: "2" },
    { limit: 0 },
    { limit: 2.5 },
  ]
  for (const extra of bad) {
    const r = await read({ path: "three.txt", ...extra } as Parameters<typeof readTool.execute>[0])
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/^(offset|limit) must be a whole number of at least 1/)
  }
})
