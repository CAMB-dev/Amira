import { afterAll, expect, test } from "bun:test"
import {
  chmod,
  type FileHandle,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { type ApplyPatchDetails, toolResultText } from "@amira/api"
import { applyPatch, applyPatchTool, type PatchIO } from "../src/apply-patch.ts"
import { applyPatchPresenter } from "../src/presenters.ts"
import { encodeText } from "../src/text.ts"
import { makeCtx, tempDirs } from "./util.ts"

const tmp = tempDirs()
afterAll(() => tmp.cleanup())
const envelope = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`
const update = (path: string, old = "old", next = "new") => `*** Update File: ${path}\n@@\n-${old}\n+${next}`
async function writeHandle(handle: FileHandle, bytes: Uint8Array) {
  await handle.write(bytes, 0, bytes.length, 0)
  await handle.truncate(bytes.length)
}

test("tool integrates add, update, move, delete and per-file presenter diffs", async () => {
  const dir = await tmp.make()
  await writeFile(join(dir, "old.txt"), "old\n")
  await writeFile(join(dir, "delete.txt"), "bye\n")
  const patch = envelope(
    "*** Add File: nested/new.txt\n+hello\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-old\n+new\n*** Delete File: delete.txt",
  )
  const result = await applyPatchTool.execute({ patch }, makeCtx(dir))
  expect(result.isError).toBeUndefined()
  expect(await readFile(join(dir, "nested/new.txt"), "utf8")).toBe("hello\n")
  expect(await readFile(join(dir, "moved.txt"), "utf8")).toBe("new\n")
  expect(await Bun.file(join(dir, "old.txt")).exists()).toBe(false)
  expect(await Bun.file(join(dir, "delete.txt")).exists()).toBe(false)
  expect(toolResultText(result)).toContain("old.txt -> moved.txt")
  const call = {
    args: { patch },
    result: { ...result, details: result.details as ApplyPatchDetails },
    text: toolResultText(result),
  }
  expect(applyPatchPresenter.summary!({ patch })).toBe("nested/new.txt, old.txt, delete.txt")
  expect(applyPatchPresenter.result!(call)).toBe("3 files · +2 -2")
  const lines = applyPatchPresenter.body!(call, { detail: "summary", width: 80 })
  expect(lines.some((line) => line.kind === "diff-add" && line.text === "new")).toBe(true)
  const resumed = { ...call, result: { content: result.content } }
  expect(
    applyPatchPresenter.body!(resumed, { detail: "full", width: 80 }).some((line) => line.text === "new"),
  ).toBe(true)
  expect(applyPatchPresenter.summary!({ patch: "garbage" })).toBe("patch")
})

test("third failing hunk validates before any file or parent directory is written", async () => {
  const dir = await tmp.make()
  await writeFile(join(dir, "a"), "one\ntwo\nthree\n")
  const patch = envelope(
    "*** Add File: nested/new\n+data\n*** Update File: a\n@@\n-one\n+1\n@@\n-two\n+2\n@@\n-missing\n+3",
  )
  const result = await applyPatchTool.execute({ patch }, makeCtx(dir))
  expect(result.isError).toBe(true)
  expect(toolResultText(result)).toContain("missing")
  expect(await readFile(join(dir, "a"), "utf8")).toBe("one\ntwo\nthree\n")
  expect(await lstat(join(dir, "nested")).catch(() => undefined)).toBeUndefined()
  expect(
    applyPatchPresenter.body!(
      { args: { patch }, result: { ...result, details: undefined }, text: toolResultText(result) },
      { detail: "full", width: 80 },
    ),
  ).toEqual([])
})

for (const encoding of ["utf-8", "utf-16le", "utf-16be"] as const) {
  for (const text of ["old\n", "old\r\n", "old", "old\r\nkeep\nlast"]) {
    test(`round-trips ${encoding} BOM and line endings ${JSON.stringify(text)}`, async () => {
      const dir = await tmp.make()
      const format = { encoding, bomLength: encoding === "utf-8" ? 3 : 2 }
      await writeFile(join(dir, "a"), encodeText(text, format))
      const result = await applyPatchTool.execute({ patch: envelope(update("a")) }, makeCtx(dir))
      expect(result.isError).toBeUndefined()
      expect(await readFile(join(dir, "a"))).toEqual(
        Buffer.from(encodeText(text.replace("old", "new"), format)),
      )
    })
  }
}

test("empty files and Unicode preserve byte content", async () => {
  const dir = await tmp.make()
  await writeFile(join(dir, "a"), "")
  const result = await applyPatchTool.execute(
    { patch: envelope("*** Update File: a\n@@\n+你好 🌏") },
    makeCtx(dir),
  )
  expect(result.isError).toBeUndefined()
  expect(await readFile(join(dir, "a"), "utf8")).toBe("你好 🌏\n")
})

test("missing delete, existing add/move and stale repeated context are refused", async () => {
  const dir = await tmp.make()
  await writeFile(join(dir, "a"), "old\n")
  for (const body of [
    "*** Delete File: missing",
    "*** Add File: a\n+x",
    "*** Update File: a\n*** Move to: a\n@@\n-old\n+new",
    `${update("a")}\n${update("a")}`,
  ]) {
    expect((await applyPatchTool.execute({ patch: envelope(body) }, makeCtx(dir))).isError).toBe(true)
    expect(await readFile(join(dir, "a"), "utf8")).toBe("old\n")
  }
})

test("outside paths, directory targets, symlink ancestors and Windows aliases are refused", async () => {
  const dir = await tmp.make()
  const outside = await tmp.make()
  await mkdir(join(dir, "folder"))
  await symlink(outside, join(dir, "link"), process.platform === "win32" ? "junction" : "dir")
  const paths = ["../escape", join(outside, "escape"), "folder", "link/escape", "."]
  if (process.platform === "win32") {
    paths.push("..\\escape", "C:\\escape", `\\\\?\\${dir}\\escape`, "\\\\localhost\\c$\\escape")
    paths.push("a:stream", "NUL", "a.", "a /file")
  }
  for (const path of paths) {
    const result = await applyPatchTool.execute(
      { patch: envelope(`*** Add File: ${path}\n+x`) },
      makeCtx(dir),
    )
    expect(result.isError).toBe(true)
  }
  expect(await Bun.file(join(outside, "escape")).exists()).toBe(false)
})

test("a workspace reached through a link still takes patches", async () => {
  const target = await tmp.make()
  const dir = join(await tmp.make(), "link")
  await symlink(target, dir, process.platform === "win32" ? "junction" : "dir")
  await writeFile(join(target, "a"), "old\n")
  const result = await applyPatchTool.execute(
    { patch: envelope(`${update("a")}\n*** Add File: sub/b\n+x`) },
    makeCtx(dir),
  )
  expect(result.isError).toBeUndefined()
  expect(await readFile(join(target, "a"), "utf8")).toBe("new\n")
  expect(await readFile(join(target, "sub", "b"), "utf8")).toBe("x\n")
})

test("Windows backslashes and absolute paths inside cwd are supported", async () => {
  const dir = await tmp.make()
  const path = process.platform === "win32" ? "folder\\a" : "folder/a"
  expect(
    (await applyPatchTool.execute({ patch: envelope(`*** Add File: ${path}\n+old`) }, makeCtx(dir))).isError,
  ).toBeUndefined()
  expect(
    (await applyPatchTool.execute({ patch: envelope(update(join(dir, "folder", "a"))) }, makeCtx(dir)))
      .isError,
  ).toBeUndefined()
  expect(await readFile(join(dir, "folder", "a"), "utf8")).toBe("new\n")
})

test("hard-linked updates write in place and every link sees the change", async () => {
  const dir = await tmp.make()
  const outside = await tmp.make()
  await writeFile(join(outside, "original"), "old\n")
  await link(join(outside, "original"), join(dir, "a"))
  const before = await lstat(join(dir, "a"))
  const result = await applyPatchTool.execute({ patch: envelope(update("a")) }, makeCtx(dir))
  expect(result.isError).toBeUndefined()
  for (const path of [join(dir, "a"), join(outside, "original")]) {
    expect(await readFile(path, "utf8")).toBe("new\n")
    expect((await lstat(path)).ino).toBe(before.ino)
    expect((await lstat(path)).nlink).toBe(2)
  }
})

test("sequential update blocks match earlier results through normalized paths", async () => {
  const dir = await tmp.make()
  const format = { encoding: "utf-16le" as const, bomLength: 2 }
  await writeFile(join(dir, "a"), encodeText("old\r\nkeep", format))
  const result = await applyPatchTool.execute(
    {
      patch: envelope(
        `${update("a", "old", "intermediate")}\n${update(join(dir, "a"), "intermediate", "final")}`,
      ),
    },
    makeCtx(dir),
  )
  expect(result.isError).toBeUndefined()
  expect(await readFile(join(dir, "a"))).toEqual(Buffer.from(encodeText("final\r\nkeep", format)))
  expect((result.details as ApplyPatchDetails).files.map((file) => file.action)).toEqual(["update", "update"])
})

const move = (from: string, to: string, old = "old", next = "new") =>
  `*** Update File: ${from}\n*** Move to: ${to}\n@@\n-${old}\n+${next}`

for (const [name, body, expected] of [
  ["update after add", `*** Add File: b\n+old\n${update("b")}`, { a: "old\n", b: "new\n" }],
  ["delete after update", `${update("a")}\n*** Delete File: a`, {}],
  ["update after move", `${move("a", "b")}\n${update("b", "new", "final")}`, { b: "final\n" }],
  ["chained moves", `${move("a", "b")}\n${move("b", "c", "new", "final")}`, { c: "final\n" }],
  ["move back to original path", `${move("a", "b")}\n${move("b", "a", "new", "final")}`, { a: "final\n" }],
  ["add after delete", `*** Delete File: a\n*** Add File: a\n+replacement`, { a: "replacement\n" }],
  ["delete after add", "*** Add File: b\n+old\n*** Delete File: b", { a: "old\n" }],
] as const) {
  test(`ordered blocks support ${name}`, async () => {
    const dir = await tmp.make()
    await writeFile(join(dir, "a"), "old\n")
    const result = await applyPatchTool.execute({ patch: envelope(body) }, makeCtx(dir))
    expect(result.isError).toBeUndefined()
    expect((await readdir(dir)).sort()).toEqual(Object.keys(expected).sort())
    for (const [path, content] of Object.entries(expected)) {
      expect(await readFile(join(dir, path), "utf8")).toBe(content)
    }
  })

  test(`I/O failure rolls back ${name} including inode identity`, async () => {
    const dir = await tmp.make()
    await writeFile(join(dir, "a"), "old\n")
    await link(join(dir, "a"), join(dir, "alias"))
    const before = await lstat(join(dir, "a"))
    let writes = 0
    const io: PatchIO = {
      async write(handle, bytes) {
        await writeHandle(handle, bytes)
        writes++
        if (Buffer.from(bytes).toString() === "fail\n") throw new Error("injected final failure")
      },
      remove: unlink,
    }
    await expect(
      applyPatch(dir, envelope(`${body}\n*** Add File: failure\n+fail`), makeCtx(dir).signal, io),
    ).rejects.toThrow("All patch changes rolled back")
    expect(writes).toBeGreaterThan(0)
    expect((await readdir(dir)).sort()).toEqual(["a", "alias"])
    for (const path of ["a", "alias"]) {
      expect(await readFile(join(dir, path), "utf8")).toBe("old\n")
      expect((await lstat(join(dir, path))).ino).toBe(before.ino)
      expect((await lstat(join(dir, path))).nlink).toBe(2)
    }
  })
}

for (const [name, body, error] of [
  ["two moves from the old source", `${move("a", "b")}\n${move("a", "c")}`, "File not found"],
  [
    "two moves into one destination",
    `${move("a", "b")}\n${move("c", "b")}`,
    "Move destination already exists",
  ],
  ["two adds", "*** Add File: b\n+x\n*** Add File: b\n+y", "Cannot add existing file"],
  ["update after delete", `*** Delete File: a\n${update("a")}`, "File not found"],
  ["two deletes", "*** Delete File: a\n*** Delete File: a", "File not found"],
  ["later context mismatch", `${update("a")}\n${update("a", "missing", "final")}`, "failed to match"],
] as const) {
  test(`${name} fails before any mutation`, async () => {
    const dir = await tmp.make()
    await writeFile(join(dir, "a"), "old\n")
    await writeFile(join(dir, "c"), "old\n")
    const result = await applyPatchTool.execute(
      { patch: envelope(`*** Add File: nested/new\n+x\n${body}`) },
      makeCtx(dir),
    )
    expect(result.isError).toBe(true)
    expect(toolResultText(result)).toContain(error)
    expect((await readdir(dir)).sort()).toEqual(["a", "c"])
    expect(await readFile(join(dir, "a"), "utf8")).toBe("old\n")
    expect(await readFile(join(dir, "c"), "utf8")).toBe("old\n")
  })
}

test("partial sequential writes restore the original bytes through every hard link", async () => {
  const dir = await tmp.make()
  const original = Buffer.from(encodeText("old\r\n", { encoding: "utf-16le", bomLength: 2 }))
  await writeFile(join(dir, "a"), original)
  await link(join(dir, "a"), join(dir, "alias"))
  const before = await lstat(join(dir, "a"))
  let writes = 0
  const io: PatchIO = {
    async write(handle, bytes) {
      if (++writes === 2) {
        await handle.write(Buffer.from("partial corruption"), 0, 18, 0)
        throw new Error("partial write failure")
      }
      await writeHandle(handle, bytes)
    },
    remove: unlink,
  }
  await expect(
    applyPatch(
      dir,
      envelope(`${update("a", "old", "intermediate")}\n${update("a", "intermediate", "final")}`),
      makeCtx(dir).signal,
      io,
    ),
  ).rejects.toThrow("All patch changes rolled back")
  expect(writes).toBe(2)
  for (const path of ["a", "alias"]) {
    expect(await readFile(join(dir, path))).toEqual(original)
    expect((await lstat(join(dir, path))).ino).toBe(before.ino)
    expect((await lstat(join(dir, path))).nlink).toBe(2)
  }
})

test("distinct hard-link paths in one patch are refused before writing", async () => {
  const dir = await tmp.make()
  await writeFile(join(dir, "a"), "old\n")
  await link(join(dir, "a"), join(dir, "alias"))
  const result = await applyPatchTool.execute(
    { patch: envelope(`${update("a")}\n${update("alias")}`) },
    makeCtx(dir),
  )
  expect(result.isError).toBe(true)
  expect(toolResultText(result)).toContain("Patch targets multiple hard links to the same file")
  expect(await readFile(join(dir, "a"), "utf8")).toBe("old\n")
})

for (const moving of [false, true]) {
  test(`hard-linked ${moving ? "move" : "delete"} preserves the other link`, async () => {
    const dir = await tmp.make()
    await writeFile(join(dir, "a"), "old\n")
    await link(join(dir, "a"), join(dir, "alias"))
    const before = await lstat(join(dir, "a"))
    const patch = envelope(moving ? move("a", "b") : "*** Delete File: a")
    const result = await applyPatchTool.execute({ patch }, makeCtx(dir))
    expect(result.isError).toBeUndefined()
    expect((await readdir(dir)).sort()).toEqual(moving ? ["alias", "b"] : ["alias"])
    expect(await readFile(join(dir, "alias"), "utf8")).toBe("old\n")
    expect((await lstat(join(dir, "alias"))).ino).toBe(before.ino)
    expect((await lstat(join(dir, "alias"))).nlink).toBe(1)
    if (moving) expect(await readFile(join(dir, "b"), "utf8")).toBe("new\n")
  })

  test(`failure after hard-linked ${moving ? "move" : "delete"} unlinks the source restores its inode`, async () => {
    const dir = await tmp.make()
    await writeFile(join(dir, "a"), "old\n")
    await link(join(dir, "a"), join(dir, "alias"))
    const before = await lstat(join(dir, "a"))
    let removed = false
    const io: PatchIO = {
      write: writeHandle,
      async remove(path) {
        await unlink(path)
        removed = true
        throw new Error("failure after unlink")
      },
    }
    const patch = envelope(moving ? move("a", "b") : "*** Delete File: a")
    await expect(applyPatch(dir, patch, makeCtx(dir).signal, io)).rejects.toThrow(
      "All patch changes rolled back",
    )
    expect(removed).toBe(true)
    expect((await readdir(dir)).sort()).toEqual(["a", "alias"])
    for (const path of ["a", "alias"]) {
      expect(await readFile(join(dir, path), "utf8")).toBe("old\n")
      expect((await lstat(join(dir, path))).ino).toBe(before.ino)
      expect((await lstat(join(dir, path))).nlink).toBe(2)
    }
  })
}

test("post-commit backup cleanup errors explicitly report that the patch was applied", async () => {
  const dir = await tmp.make()
  await writeFile(join(dir, "a"), "old\n")
  const io: PatchIO = {
    write: writeHandle,
    async remove(path) {
      await unlink(path)
      const backup = (await readdir(dir)).find((name) => name.startsWith(".amira-patch-"))!
      await writeFile(join(dir, backup, "unexpected"), "external")
    },
  }
  await expect(applyPatch(dir, envelope("*** Delete File: a"), makeCtx(dir).signal, io)).rejects.toThrow(
    "Patch applied, but temporary backup cleanup failed",
  )
  expect(await Bun.file(join(dir, "a")).exists()).toBe(false)
})

test("a stale later file is preserved while earlier writes roll back", async () => {
  const dir = await tmp.make()
  await writeFile(join(dir, "a"), "old\n")
  await writeFile(join(dir, "b"), "old\n")
  const io: PatchIO = {
    async write(handle, bytes) {
      await writeHandle(handle, bytes)
      await writeFile(join(dir, "b"), "external change")
    },
    remove: unlink,
  }
  await expect(
    applyPatch(dir, envelope(`${update("a")}\n${update("b")}`), makeCtx(dir).signal, io),
  ).rejects.toThrow("File changed")
  expect(await readFile(join(dir, "a"), "utf8")).toBe("old\n")
  expect(await readFile(join(dir, "b"), "utf8")).toBe("external change")
})

test("I/O failure after partial third write restores all bytes and directories", async () => {
  const dir = await tmp.make()
  await writeFile(join(dir, "a"), "old\n")
  await writeFile(join(dir, "b"), "old\n")
  let writes = 0
  const io: PatchIO = {
    async write(handle, bytes) {
      await writeHandle(handle, bytes)
      if (++writes === 3) throw new Error("simulated disk failure")
    },
    remove: unlink,
  }
  const patch = envelope(`${update("a")}\n*** Add File: nested/new\n+x\n${update("b")}`)
  await expect(applyPatch(dir, patch, makeCtx(dir).signal, io)).rejects.toThrow(
    "All patch changes rolled back",
  )
  expect(await readFile(join(dir, "a"), "utf8")).toBe("old\n")
  expect(await readFile(join(dir, "b"), "utf8")).toBe("old\n")
  expect(await lstat(join(dir, "nested")).catch(() => undefined)).toBeUndefined()
})

test("failed move source deletion restores the original and removes its destination", async () => {
  const dir = await tmp.make()
  await writeFile(join(dir, "a"), "old\n")
  const io: PatchIO = {
    write: writeHandle,
    remove: async () => {
      throw new Error("delete denied")
    },
  }
  await expect(
    applyPatch(
      dir,
      envelope("*** Update File: a\n*** Move to: moved\n@@\n-old\n+new"),
      makeCtx(dir).signal,
      io,
    ),
  ).rejects.toThrow("rolled back")
  expect(await readFile(join(dir, "a"), "utf8")).toBe("old\n")
  expect(await Bun.file(join(dir, "moved")).exists()).toBe(false)
})

test("concurrent destination creation is retained and earlier writes roll back", async () => {
  const dir = await tmp.make()
  await writeFile(join(dir, "a"), "old\n")
  const io: PatchIO = {
    async write(handle, bytes) {
      await writeHandle(handle, bytes)
      await writeFile(join(dir, "destination"), "external")
    },
    remove: unlink,
  }
  await expect(
    applyPatch(dir, envelope(`${update("a")}\n*** Add File: destination\n+patch`), makeCtx(dir).signal, io),
  ).rejects.toThrow("File changed")
  expect(await readFile(join(dir, "a"), "utf8")).toBe("old\n")
  expect(await readFile(join(dir, "destination"), "utf8")).toBe("external")
})

test("concurrent replacement is never overwritten during rollback", async () => {
  const dir = await tmp.make()
  await writeFile(join(dir, "a"), "old\n")
  await writeFile(join(dir, "b"), "old\n")
  let writes = 0
  const io: PatchIO = {
    async write(handle, bytes) {
      await writeHandle(handle, bytes)
      if (++writes === 2) {
        await rename(join(dir, "a"), join(dir, "external-backup"))
        await writeFile(join(dir, "a"), "external replacement")
        throw new Error("failure")
      }
    },
    remove: unlink,
  }
  await expect(
    applyPatch(dir, envelope(`${update("a")}\n${update("b")}`), makeCtx(dir).signal, io),
  ).rejects.toThrow("Rollback incomplete")
  expect(await readFile(join(dir, "a"), "utf8")).toBe("external replacement")
  expect(await readFile(join(dir, "b"), "utf8")).toBe("old\n")
})

test("aborted requests and invalid UTF-8 never write", async () => {
  const dir = await tmp.make()
  await writeFile(join(dir, "a"), Buffer.from([0xff, 0x41]))
  expect((await applyPatchTool.execute({ patch: envelope(update("a")) }, makeCtx(dir))).isError).toBe(true)
  const aborted = AbortSignal.abort()
  expect(
    (await applyPatchTool.execute({ patch: envelope("*** Add File: new\n+x") }, makeCtx(dir, aborted)))
      .isError,
  ).toBe(true)
  expect(await Bun.file(join(dir, "new")).exists()).toBe(false)
})

test("invalid UTF-16 updates are refused and binary files can be deleted", async () => {
  const dir = await tmp.make()
  const malformed = Buffer.from([0xff, 0xfe, 0x41])
  await writeFile(join(dir, "a"), malformed)
  expect((await applyPatchTool.execute({ patch: envelope(update("a", "�")) }, makeCtx(dir))).isError).toBe(
    true,
  )
  expect(await readFile(join(dir, "a"))).toEqual(malformed)
  await writeFile(join(dir, "binary"), Buffer.from([0, 1, 2]))
  expect(
    (await applyPatchTool.execute({ patch: envelope("*** Delete File: binary") }, makeCtx(dir))).isError,
  ).toBeUndefined()
  expect(await Bun.file(join(dir, "binary")).exists()).toBe(false)
})

test("conflicting file/directory targets are rejected before mutations", async () => {
  const dir = await tmp.make()
  const io: PatchIO = {
    write: async () => {
      throw new Error("unexpected write")
    },
    remove: unlink,
  }
  await expect(
    applyPatch(dir, envelope("*** Add File: a\n+x\n*** Add File: a/b\n+y"), makeCtx(dir).signal, io),
  ).rejects.toThrow("file and directory")
  expect(await Bun.file(join(dir, "a")).exists()).toBe(false)
})

test("move preserves executable mode where supported", async () => {
  const dir = await tmp.make()
  await writeFile(join(dir, "a"), "old\n")
  await chmod(join(dir, "a"), 0o755)
  const mode = (await lstat(join(dir, "a"))).mode & 0o777
  const result = await applyPatchTool.execute(
    { patch: envelope("*** Update File: a\n*** Move to: b\n@@\n-old\n+new") },
    makeCtx(dir),
  )
  expect(result.isError).toBeUndefined()
  expect((await lstat(join(dir, "b"))).mode & 0o777).toBe(mode)
  expect((result.details as ApplyPatchDetails).files[0]?.action).toBe("move")
})
