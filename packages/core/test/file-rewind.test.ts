import { afterAll, expect, spyOn, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { userMessage } from "@amira/ai"
import { type Settings, type ToolContext, toolResultText } from "@amira/api"
import { applyPatch, applyPatchTool } from "../../../extensions/builtin-tools/src/apply-patch.ts"
import { editTool } from "../../../extensions/builtin-tools/src/edit.ts"
import { writeTool } from "../../../extensions/builtin-tools/src/write.ts"
import { copyFileHistory, FileRewind, intermediate } from "../src/file-rewind.ts"
import { deleteSession } from "../src/session-list.ts"
import { SessionStore } from "../src/session-store.ts"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function setup(settings?: Settings["fileRewind"]) {
  // Journal paths are real paths; a temp dir reached through an alias would not compare equal.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "amira-file-rewind-")))
  dirs.push(dir)
  const store = SessionStore.create({ cwd: dir, dir: join(dir, "sessions") })
  const messageId = store.appendMessage(userMessage("first"))
  const rewind = new FileRewind(store, settings)
  const source = { sessionId: store.id, toolCallId: "call-1", turnId: "turn-1" }
  const ctx: ToolContext = {
    cwd: dir,
    toolCallId: source.toolCallId,
    signal: new AbortController().signal,
    update: () => {},
    mutateFiles: (changes, write) => rewind.mutate(changes, write, source),
  }
  const write = async (name: string, content: string) => {
    const result = await writeTool.execute({ path: name, content }, ctx)
    expect(result.isError, toolResultText(result)).not.toBe(true)
  }
  return { dir, store, messageId, rewind, ctx, write }
}

test("write captures a new file and a binary overwrite; edit preserves bytes across several turns", async () => {
  const { dir, store, messageId, rewind, ctx, write } = setup()
  const binary = Buffer.from([0, 255, 1, 128])
  writeFileSync(join(dir, "binary"), binary)
  await write("new", "first\n")
  await write("binary", "text")
  const second = store.appendMessage(userMessage("second"))
  const result = await editTool.execute({ path: "new", old_string: "first", new_string: "second" }, ctx)
  expect(result.isError).not.toBe(true)
  const third = store.appendMessage(userMessage("third"))
  await write("new", "third\n")
  const entries = store.entries.filter((e) => e.type === "file_mutation")
  expect(entries.map((e) => e.messageId)).toEqual([messageId, messageId, second, third])
  expect(entries[0]).toMatchObject({
    toolCallId: "call-1",
    turnId: "turn-1",
    files: [{ path: join(dir, "new"), before: null }],
  })
  const resumed = new FileRewind(SessionStore.open(store.file))
  expect(resumed.plan(second)).toMatchObject({ restored: 1, removed: 0, conflicts: [] })
  resumed.restore(second, store.get(second)!.parentId)
  expect(readFileSync(join(dir, "new"), "utf8")).toBe("first\n")
  resumed.restore(messageId, null)
  expect(existsSync(join(dir, "new"))).toBe(false)
  expect(readFileSync(join(dir, "binary"))).toEqual(binary)
  expect(resumed.store.restore().messages).toHaveLength(0)
  expect(readdirSync(rewind.directory).length).toBeGreaterThan(0)
})

test("apply_patch captures add, move, update and binary deletion as one mutation", async () => {
  const { dir, ctx, store, rewind, messageId } = setup()
  writeFileSync(join(dir, "old"), "old\n")
  writeFileSync(join(dir, "update"), "old\n")
  const binary = Buffer.from([0, 255])
  writeFileSync(join(dir, "binary"), binary)
  const result = await applyPatchTool.execute(
    {
      patch:
        "*** Begin Patch\n*** Add File: nested/new\n+new\n*** Update File: old\n*** Move to: moved\n@@\n-old\n+changed\n*** Update File: update\n@@\n-old\n+updated\n*** Delete File: binary\n*** End Patch",
    },
    ctx,
  )
  expect(result.isError, toolResultText(result)).not.toBe(true)
  expect(store.entries.filter((e) => e.type === "file_mutation")).toHaveLength(1)
  expect(rewind.plan(messageId)).toMatchObject({ restored: 3, removed: 2, conflicts: [] })
  rewind.restore(messageId, null)
  expect(readFileSync(join(dir, "old"), "utf8")).toBe("old\n")
  expect(readFileSync(join(dir, "update"), "utf8")).toBe("old\n")
  expect(readFileSync(join(dir, "binary"))).toEqual(binary)
  expect(existsSync(join(dir, "moved"))).toBe(false)
  expect(existsSync(join(dir, "nested/new"))).toBe(false)
})

test("apply_patch rollback is recorded without phantom changes to restore", async () => {
  const { dir, ctx, store, rewind, messageId } = setup()
  writeFileSync(join(dir, "a"), "old\n")
  let writes = 0
  await expect(
    applyPatch(
      dir,
      "*** Begin Patch\n*** Update File: a\n@@\n-old\n+new\n*** Add File: b\n+new\n*** End Patch",
      ctx.signal,
      {
        write: async (handle, bytes) => {
          await handle.write(bytes, 0, bytes.length, 0)
          if (++writes === 2) throw new Error("disk full")
          await handle.truncate(bytes.length)
        },
        remove: async () => {},
      },
      ctx.mutateFiles,
    ),
  ).rejects.toThrow("All patch changes rolled back")
  expect(readFileSync(join(dir, "a"), "utf8")).toBe("old\n")
  expect(existsSync(join(dir, "b"))).toBe(false)
  expect(store.entries.some((e) => e.type === "file_mutation_end" && e.rolledBack)).toBe(true)
  expect(rewind.plan(messageId)).toMatchObject({ restored: 0, removed: 0, conflicts: [] })
})

for (const tool of ["write", "edit", "apply_patch"] as const) {
  test(`${tool} refuses its write when the pre-image store fails`, async () => {
    const { dir, rewind, ctx, store } = setup()
    writeFileSync(join(dir, "a"), "old\n")
    mkdirSync(dirname(rewind.directory), { recursive: true })
    writeFileSync(rewind.directory, "not a directory")
    const result =
      tool === "write"
        ? await writeTool.execute({ path: "a", content: "new\n" }, ctx)
        : tool === "edit"
          ? await editTool.execute({ path: "a", old_string: "old", new_string: "new" }, ctx)
          : await applyPatchTool.execute(
              {
                patch:
                  "*** Begin Patch\n*** Update File: a\n@@\n-old\n+new\n*** Add File: b\n+new\n*** End Patch",
              },
              ctx,
            )
    expect(result.isError).toBe(true)
    expect(toolResultText(result)).toContain("capture failed; write refused")
    expect(readFileSync(join(dir, "a"), "utf8")).toBe("old\n")
    expect(existsSync(join(dir, "b"))).toBe(false)
    expect(store.entries.filter((e) => e.type === "file_mutation")).toHaveLength(0)
  })
}

test("a journal append failure refuses the write too", async () => {
  const { dir, ctx, store } = setup()
  const fail = spyOn(store, "appendDurable").mockImplementation(() => {
    throw new Error("journal unavailable")
  })
  try {
    const result = await writeTool.execute({ path: "a", content: "new" }, ctx)
    expect(result.isError).toBe(true)
    expect(toolResultText(result)).toContain("journal unavailable")
    expect(existsSync(join(dir, "a"))).toBe(false)
  } finally {
    fail.mockRestore()
  }
})

test("a shell edit refuses the whole restore, including untouched files and checkout", async () => {
  const { dir, store, rewind, messageId, write } = setup()
  writeFileSync(join(dir, "a"), "original")
  await write("a", "tool")
  await write("new", "created")
  writeFileSync(join(dir, "a"), "shell")
  const leaf = store.leafId
  expect(rewind.plan(messageId).conflicts).toEqual([join(dir, "a")])
  expect(() => rewind.restore(messageId, null)).toThrow("nothing changed")
  expect(readFileSync(join(dir, "a"), "utf8")).toBe("shell")
  expect(readFileSync(join(dir, "new"), "utf8")).toBe("created")
  expect(store.leafId).toBe(leaf)
})

test("shell changes between two captured writes are detected when crossing that gap", async () => {
  const { dir, store, rewind, messageId, write } = setup()
  await write("a", "first")
  writeFileSync(join(dir, "a"), "shell")
  const second = store.appendMessage(userMessage("second"))
  await write("a", "second")
  expect(rewind.plan(messageId).conflicts).toEqual([join(dir, "a")])
  expect(rewind.plan(second).conflicts).toEqual([])
  rewind.restore(second, store.get(second)!.parentId)
  expect(readFileSync(join(dir, "a"), "utf8")).toBe("shell")
})

for (const point of ["before progress", "after progress", "after checkout"] as const) {
  test(`a crash ${point} resumes safely from the on-disk journal`, async () => {
    const { dir, store, rewind, messageId, write } = setup()
    writeFileSync(join(dir, "a"), "original")
    await write("a", "changed")
    await write("b", "created")
    const append = store.appendDurable.bind(store)
    let interrupted = false
    const crash = spyOn(store, "appendDurable").mockImplementation((entry) => {
      const matches =
        point === "after checkout" ? entry.type === "checkout" : entry.type === "file_restore_progress"
      if (matches && !interrupted) {
        interrupted = true
        if (point !== "before progress") append(entry)
        throw new Error("simulated crash")
      }
      return append(entry)
    })
    try {
      expect(() => rewind.restore(messageId, null)).toThrow("simulated crash")
    } finally {
      crash.mockRestore()
    }
    expect(readFileSync(join(dir, "a"), "utf8")).toBe("original")
    if (point !== "after checkout") expect(existsSync(join(dir, "b"))).toBe(true)
    const resumed = new FileRewind(SessionStore.open(store.file))
    resumed.recover()
    resumed.recover()
    expect(existsSync(join(dir, "b"))).toBe(false)
    expect(resumed.store.restore().messages).toHaveLength(0)
    expect(resumed.store.entries.filter((e) => e.type === "file_restore_end")).toHaveLength(1)
  })
}

test("resume checks already-restored files before touching the remainder", async () => {
  const { dir, store, rewind, messageId, write } = setup()
  await write("a", "new a")
  await write("b", "new b")
  const append = store.appendDurable.bind(store)
  const crash = spyOn(store, "appendDurable").mockImplementation((entry) => {
    const id = append(entry)
    if (entry.type === "file_restore_progress") throw new Error("crash")
    return id
  })
  try {
    expect(() => rewind.restore(messageId, null)).toThrow("crash")
  } finally {
    crash.mockRestore()
  }
  writeFileSync(join(dir, "a"), "external")
  expect(() => new FileRewind(SessionStore.open(store.file)).recover()).toThrow("Conflicts")
  expect(readFileSync(join(dir, "b"), "utf8")).toBe("new b")
})

test("size cap refuses oversized pre-images and post-images; disabling capture permits them", async () => {
  const { dir, ctx, rewind } = setup({ maxFileBytes: 4 })
  writeFileSync(join(dir, "large"), "12345")
  expect((await writeTool.execute({ path: "large", content: "small" }, ctx)).isError).toBe(true)
  expect(readFileSync(join(dir, "large"), "utf8")).toBe("12345")
  expect((await writeTool.execute({ path: "new", content: "12345" }, ctx)).isError).toBe(true)
  expect(existsSync(join(dir, "new"))).toBe(false)
  const off = new FileRewind(rewind.store, { enabled: false, maxFileBytes: 1 })
  ctx.mutateFiles = (changes, write) =>
    off.mutate(changes, write, { sessionId: "s", toolCallId: "t", turnId: "t" })
  expect((await writeTool.execute({ path: "large", content: "allowed" }, ctx)).isError).not.toBe(true)
  expect(readFileSync(join(dir, "large"), "utf8")).toBe("allowed")
})

test("quota counts unique images, explicit prune frees it, and deleting a session removes the store", async () => {
  const { dir, store, ctx, rewind, messageId, write } = setup({ quotaBytes: 6 })
  await write("a", "abc")
  await write("b", "abc")
  await write("a", "def")
  const result = await writeTool.execute({ path: "b", content: "ghi" }, ctx)
  expect(result.isError).toBe(true)
  expect(toolResultText(result)).toContain("quota exceeded")
  expect(readFileSync(join(dir, "b"), "utf8")).toBe("abc")
  expect(rewind.prune()).toEqual({ files: 2, bytes: 6 })
  expect(rewind.plan(messageId)).toMatchObject({ enabled: false, restored: 0, removed: 0 })
  expect(rewind.plan(messageId).note).toContain("pruned")
  store.appendMessage(userMessage("after prune"))
  await write("b", "ghi")
  deleteSession(dir, store.id, undefined, join(dir, "sessions"))
  expect(existsSync(store.file)).toBe(false)
  expect(existsSync(rewind.directory)).toBe(false)
  expect(existsSync(join(dir, "a"))).toBe(true)
})

test("a fork cannot restore history pruned on a branch it leaves out", async () => {
  const { store, rewind, messageId, write } = setup()
  await write("a", "abc")
  const second = store.appendMessage(userMessage("second"))
  await write("b", "x")
  rewind.prune()
  store.append({ type: "checkout", target: store.get(second)!.parentId })
  expect(rewind.plan(messageId).note).toContain("pruned")
  const forked = store.fork()
  copyFileHistory(store, forked)
  expect(new FileRewind(forked).plan(messageId)).toMatchObject({ enabled: false, removed: 0 })
  expect(new FileRewind(SessionStore.open(forked.file)).plan(messageId).note).toContain("pruned")
})

test("damaged pre-images stop all restoration", async () => {
  const { dir, store, rewind, messageId, write } = setup()
  writeFileSync(join(dir, "a"), "original")
  await write("a", "changed")
  await write("b", "new")
  const change = store.entries.find((e) => e.type === "file_mutation")!
  if (change.type !== "file_mutation") throw new Error("missing mutation")
  writeFileSync(join(rewind.directory, change.files[0]!.before!), "damaged")
  expect(() => rewind.restore(messageId, null)).toThrow("damaged pre-image")
  expect(readFileSync(join(dir, "a"), "utf8")).toBe("changed")
  expect(existsSync(join(dir, "b"))).toBe(true)
})

test("the shared recorder serializes writers and refuses rewind while a write is pending", async () => {
  const { dir, rewind, messageId, ctx } = setup()
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = ctx.mutateFiles!([{ path: join(dir, "a"), after: Buffer.from("one") }], async () => {
    started()
    await wait
    writeFileSync(join(dir, "a"), "one")
  })
  await ready
  const second = writeTool.execute({ path: "a", content: "two" }, ctx)
  expect(() => rewind.restore(messageId, null)).toThrow("still running")
  release()
  await first
  expect((await second).isError).not.toBe(true)
  expect(rewind.plan(messageId).conflicts).toEqual([])
  rewind.restore(messageId, null)
  expect(existsSync(join(dir, "a"))).toBe(false)
})

test("a workspace reached through a junction is captured at its real path and restored", async () => {
  const { dir, store, messageId } = setup()
  const real = join(dir, "real")
  mkdirSync(real)
  writeFileSync(join(real, "a"), "original")
  const link = join(dir, "link")
  symlinkSync(real, link, "junction")
  const rewind = new FileRewind(store)
  const source = { sessionId: store.id, toolCallId: "call-2", turnId: "turn-2" }
  const ctx: ToolContext = {
    cwd: link,
    toolCallId: source.toolCallId,
    signal: new AbortController().signal,
    update: () => {},
    mutateFiles: (changes, write) => rewind.mutate(changes, write, source),
  }
  const result = await writeTool.execute({ path: "a", content: "changed" }, ctx)
  expect(result.isError, toolResultText(result)).not.toBe(true)
  const mutation = store.entries.findLast((e) => e.type === "file_mutation")
  expect(mutation).toMatchObject({ files: [{ path: join(real, "a") }] })
  rewind.restore(messageId, null)
  expect(readFileSync(join(real, "a"), "utf8")).toBe("original")
})

test("a directory swapped for a junction after capture makes the path a conflict, not a redirected write", async () => {
  const { dir, store, rewind, messageId, write } = setup()
  mkdirSync(join(dir, "sub"))
  await write("sub/a", "created")
  const elsewhere = join(dir, "elsewhere")
  mkdirSync(elsewhere)
  writeFileSync(join(elsewhere, "a"), "created")
  rmSync(join(dir, "sub"), { recursive: true })
  symlinkSync(elsewhere, join(dir, "sub"), "junction")
  expect(rewind.plan(messageId).conflicts).toEqual([join(dir, "sub", "a")])
  expect(() => rewind.restore(messageId, null)).toThrow("nothing changed")
  expect(readFileSync(join(elsewhere, "a"), "utf8")).toBe("created")
  expect(store.entries.some((e) => e.type === "file_restore")).toBe(false)
})

test("hard-linked files are captured and restored in place, so every link sees the pre-image", async () => {
  const { dir, rewind, messageId, ctx } = setup()
  writeFileSync(join(dir, "a"), "old\n")
  linkSync(join(dir, "a"), join(dir, "twin"))
  const inode = statSync(join(dir, "a")).ino
  const result = await editTool.execute({ path: "a", old_string: "old", new_string: "new" }, ctx)
  expect(result.isError, toolResultText(result)).not.toBe(true)
  expect(readFileSync(join(dir, "twin"), "utf8")).toBe("new\n")
  rewind.restore(messageId, null)
  expect(readFileSync(join(dir, "twin"), "utf8")).toBe("old\n")
  expect(statSync(join(dir, "a")).ino).toBe(inode)
  expect(statSync(join(dir, "a")).nlink).toBe(2)
})

test("an in-place restore torn by a crash resumes on the same inode, but not on a replaced file", async () => {
  for (const replaced of [false, true]) {
    const { dir, store, rewind, messageId, write } = setup()
    writeFileSync(join(dir, "a"), "original contents")
    linkSync(join(dir, "a"), join(dir, "twin"))
    await write("a", "tool")
    const append = store.appendDurable.bind(store)
    const crash = spyOn(store, "appendDurable").mockImplementation((entry) => {
      const id = append(entry)
      if (entry.type === "file_restore_progress" && entry.started) {
        writeFileSync(join(dir, "a"), "orig") // the torn half of the in-place write
        throw new Error("simulated crash")
      }
      return id
    })
    try {
      expect(() => rewind.restore(messageId, null)).toThrow("simulated crash")
    } finally {
      crash.mockRestore()
    }
    if (replaced) {
      rmSync(join(dir, "a"))
      writeFileSync(join(dir, "a"), "orig")
    }
    const resumed = new FileRewind(SessionStore.open(store.file))
    if (replaced) {
      expect(() => resumed.recover()).toThrow("Conflicts")
      expect(readFileSync(join(dir, "a"), "utf8")).toBe("orig")
    } else {
      resumed.recover()
      expect(readFileSync(join(dir, "twin"), "utf8")).toBe("original contents")
    }
  }
})

test("a tool that crashed before writing is no conflict for a later write of the same file", async () => {
  const { dir, store, rewind, messageId, write } = setup()
  writeFileSync(join(dir, "a"), "original")
  const end = store.appendDurable.bind(store)
  const crash = spyOn(store, "appendDurable").mockImplementation((entry) => {
    if (entry.type === "file_mutation") {
      end(entry)
      throw new Error("process died before the write")
    }
    return end(entry)
  })
  try {
    await rewind
      .mutate([{ path: join(dir, "a"), after: Buffer.from("never written") }], async () => {}, {
        sessionId: store.id,
        toolCallId: "lost",
        turnId: "turn-1",
      })
      .catch(() => {})
  } finally {
    crash.mockRestore()
  }
  await write("a", "second")
  expect(rewind.plan(messageId)).toMatchObject({ conflicts: [], restored: 1 })
  rewind.restore(messageId, null)
  expect(readFileSync(join(dir, "a"), "utf8")).toBe("original")
})

test("abandoning is only for a restore conflicts keep from finishing", async () => {
  const { dir, store, rewind, messageId, write } = setup()
  await write("a", "new a")
  await write("b", "new b")
  const append = store.appendDurable.bind(store)
  const crash = spyOn(store, "appendDurable").mockImplementation((entry) => {
    const id = append(entry)
    if (entry.type === "file_restore_progress") throw new Error("crash")
    return id
  })
  try {
    expect(() => rewind.restore(messageId, null)).toThrow("crash")
  } finally {
    crash.mockRestore()
  }
  // After a restart (no failure seen in this process) a finishable restore must finish.
  expect(() => new FileRewind(SessionStore.open(store.file)).abandon()).toThrow("can still finish")
  writeFileSync(join(dir, "b"), "external")
  expect(rewind.interrupted()).toMatchObject({ messageId, conflicts: [join(dir, "b")] })
  await expect(write("c", "blocked")).rejects.toThrow()
  rewind.abandon()
  expect(rewind.restoring).toBe(false)
  expect(readFileSync(join(dir, "b"), "utf8")).toBe("external")
  await write("c", "allowed")
})

if (process.platform === "win32") {
  test("case aliases of one file share one journal path on Windows", async () => {
    const { dir, rewind, messageId, write } = setup()
    writeFileSync(join(dir, "Name.txt"), "original")
    await write("name.TXT", "first")
    await write("NAME.txt", "second")
    expect(rewind.plan(messageId)).toMatchObject({ conflicts: [], restored: 1, removed: 0 })
    rewind.restore(messageId, null)
    expect(readFileSync(join(dir, "Name.txt"), "utf8")).toBe("original")
    expect(readdirSync(dir).filter((n) => n.toLowerCase() === "name.txt")).toEqual(["Name.txt"])
  })
}

test("an edit made on the same inode after an interrupted in-place restore is a conflict, not torn bytes", async () => {
  const { dir, store, rewind, messageId, write } = setup()
  writeFileSync(join(dir, "a"), "original contents")
  linkSync(join(dir, "a"), join(dir, "twin"))
  await write("a", "tool")
  const append = store.appendDurable.bind(store)
  const crash = spyOn(store, "appendDurable").mockImplementation((entry) => {
    const id = append(entry)
    if (entry.type === "file_restore_progress" && entry.started) throw new Error("simulated crash")
    return id
  })
  try {
    expect(() => rewind.restore(messageId, null)).toThrow("simulated crash")
  } finally {
    crash.mockRestore()
  }
  writeFileSync(join(dir, "a"), "user edit") // in place: same inode
  expect(() => new FileRewind(SessionStore.open(store.file)).recover()).toThrow("Conflicts")
  expect(readFileSync(join(dir, "twin"), "utf8")).toBe("user edit")
})

test("intermediate accepts only the states of an in-place write cut off at some byte", () => {
  const before = Buffer.from("abcdef")
  const after = Buffer.from("XYZ")
  for (const ok of ["XYZ", "aYZ", "abZ", "abc", "abcd", "abcdef"])
    expect(intermediate(Buffer.from(ok), before, after)).toBe(true)
  for (const bad of ["XbZ", "abcX", "ab", "abcdefg", "user"])
    expect(intermediate(Buffer.from(bad), before, after)).toBe(false)
})

test("a change that slips in between planning and applying leaves no pending restore", async () => {
  const { dir, store, rewind, messageId, write } = setup()
  await write("a", "tool")
  const append = store.appendDurable.bind(store)
  const race = spyOn(store, "appendDurable").mockImplementation((entry) => {
    const id = append(entry)
    if (entry.type === "file_restore") writeFileSync(join(dir, "a"), "racing writer")
    return id
  })
  try {
    expect(() => rewind.restore(messageId, null)).toThrow("nothing changed")
  } finally {
    race.mockRestore()
  }
  expect(rewind.restoring).toBe(false)
  expect(readFileSync(join(dir, "a"), "utf8")).toBe("racing writer")
  await write("b", "file tools still write")
})

test("a restore that fails for an I/O error can be abandoned, and a read-only file is still restored", async () => {
  const { dir, store, rewind, messageId, write } = setup()
  writeFileSync(join(dir, "a"), "original")
  await write("a", "tool")
  await write("b", "tool")
  chmodSync(join(dir, "a"), 0o444)
  rewind.restore(messageId, null)
  expect(readFileSync(join(dir, "a"), "utf8")).toBe("original")
  expect(existsSync(join(dir, "b"))).toBe(false)

  const second = store.appendMessage(userMessage("second"))
  await write("c", "tool")
  const append = store.appendDurable.bind(store)
  const fail = spyOn(store, "appendDurable").mockImplementation((entry) => {
    if (entry.type === "file_restore_progress") throw new Error("EIO: disk went away")
    return append(entry)
  })
  try {
    expect(() => rewind.restore(second, store.get(second)!.parentId)).toThrow("EIO")
  } finally {
    fail.mockRestore()
  }
  expect(rewind.interrupted()).toMatchObject({ conflicts: [], failure: expect.stringContaining("EIO") })
  expect(rewind.plan(second).note).toContain("abandons it")
  rewind.abandon()
  expect(rewind.restoring).toBe(false)
})

test("capture refuses relative paths, and a failing end marker does not fail a finished write", async () => {
  const { dir, store, rewind } = setup()
  const source = { sessionId: store.id, toolCallId: "x", turnId: "t" }
  await expect(
    rewind.mutate([{ path: "a", after: Buffer.from("x") }], async () => {}, source),
  ).rejects.toThrow("Not an absolute path")
  const append = store.appendDurable.bind(store)
  const fail = spyOn(store, "appendDurable").mockImplementation((entry) => {
    if (entry.type === "file_mutation_end") throw new Error("disk hiccup")
    return append(entry)
  })
  try {
    await rewind.mutate(
      [{ path: join(dir, "a"), after: Buffer.from("x") }],
      async () => writeFileSync(join(dir, "a"), "x"),
      source,
    )
  } finally {
    fail.mockRestore()
  }
  expect(readFileSync(join(dir, "a"), "utf8")).toBe("x")
})

test("a damaged image is rewritten when the same bytes are captured again", async () => {
  const { dir, store, rewind, messageId, write } = setup()
  writeFileSync(join(dir, "a"), "original")
  await write("a", "tool")
  const key = store.entries.find((e) => e.type === "file_mutation")!
  if (key.type !== "file_mutation") throw new Error("missing mutation")
  writeFileSync(join(rewind.directory, key.files[0]!.before!), "damaged")
  writeFileSync(join(dir, "b"), "original")
  await write("b", "tool")
  expect(rewind.plan(messageId).conflicts).toEqual([])
  rewind.restore(messageId, null)
  expect(readFileSync(join(dir, "a"), "utf8")).toBe("original")
})
