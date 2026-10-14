import { afterAll, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { userMessage } from "@amira/ai"
import { copyFileHistory, FileRewind } from "../src/file-rewind.ts"
import { SessionStore } from "../src/session-store.ts"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

async function setup() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "amira-rewind-acceptance-")))
  dirs.push(dir)
  const file = join(dir, "a")
  writeFileSync(file, "original")
  const store = SessionStore.create({ cwd: dir, dir: join(dir, "sessions") })
  const rewind = new FileRewind(store)
  const write = async (recorder: FileRewind, content: string) =>
    recorder.mutate([{ path: file, after: Buffer.from(content) }], async () => writeFileSync(file, content), {
      sessionId: recorder.store.id,
      toolCallId: "write",
      turnId: "turn",
    })
  const first = store.appendMessage(userMessage("first"))
  await write(rewind, "first")
  const second = store.appendMessage(userMessage("second"))
  await write(rewind, "second")
  return { file, store, rewind, write, first, second }
}

for (const external of [false, true]) {
  test(`fork retains discarded writes for expected-state checks (external edit: ${external})`, async () => {
    const { file, store, rewind, first, second } = await setup()
    store.append({ type: "checkout", target: store.get(second)!.parentId })
    const forked = store.fork()
    copyFileHistory(store, forked)
    const recorder = new FileRewind(SessionStore.open(forked.file))
    expect(recorder.store.restore().messages).toEqual([userMessage("first")])
    if (external) writeFileSync(file, "first")
    const conflicts = external ? [file] : []
    expect(rewind.plan(first).conflicts).toEqual(conflicts)
    expect(recorder.plan(first).conflicts).toEqual(conflicts)
    if (external) {
      const leaf = recorder.store.leafId
      expect(() => recorder.restore(first, null)).toThrow("nothing changed")
      expect(recorder.store.leafId).toBe(leaf)
      expect(readFileSync(file, "utf8")).toBe("first")
    } else {
      recorder.restore(first, null)
      expect(readFileSync(file, "utf8")).toBe("original")
    }
  })
}

test("fork retains gap provenance and restore references after replacement writes", async () => {
  const { file, store, rewind, write, first, second } = await setup()
  store.append({ type: "checkout", target: store.get(second)!.parentId })
  writeFileSync(file, "external gap")
  const replacement = store.appendMessage(userMessage("replacement"))
  await write(rewind, "replacement")
  rewind.restore(replacement, store.get(replacement)!.parentId)
  const forked = store.fork()
  copyFileHistory(store, forked)
  const recorder = new FileRewind(SessionStore.open(forked.file))
  expect(recorder.store.restore().messages).toEqual([userMessage("first")])
  expect(recorder.plan(first).conflicts).toEqual([file])
  expect(() => recorder.restore(first, null)).toThrow("nothing changed")
  expect(readFileSync(file, "utf8")).toBe("external gap")
  for (const entry of recorder.store.entries) {
    if (entry.type === "file_mutation_end")
      expect(recorder.store.get(entry.mutationId)?.type).toBe("file_mutation")
    if (entry.type === "file_restore_end" || entry.type === "file_restore_progress")
      expect(recorder.store.get(entry.restoreId)?.type).toBe("file_restore")
  }
})

for (const fork of [false, true]) {
  for (const external of [false, true]) {
    test(`skipped restore journals its target observation (fork: ${fork}, external: ${external})`, async () => {
      const { file, store, rewind, first, second } = await setup()
      writeFileSync(file, "first")
      const inode = statSync(file, { bigint: true }).ino
      expect(rewind.plan(second)).toMatchObject({ restored: 0, removed: 0, conflicts: [] })
      rewind.restore(second, store.get(second)!.parentId)
      expect(statSync(file, { bigint: true }).ino).toBe(inode)
      const selected = fork ? store.fork() : SessionStore.open(store.file)
      if (fork) copyFileHistory(store, selected)
      const recorder = new FileRewind(selected)
      if (external) writeFileSync(file, "second")
      expect(recorder.plan(first).conflicts).toEqual(external ? [file] : [])
      if (external) {
        expect(() => recorder.restore(first, null)).toThrow("nothing changed")
        expect(readFileSync(file, "utf8")).toBe("second")
      } else {
        recorder.restore(first, null)
        expect(readFileSync(file, "utf8")).toBe("original")
      }
    })
  }
}

for (const fork of [false, true]) {
  test(`a refused, unapplied restore does not authorize external target bytes (fork: ${fork})`, async () => {
    const { file, store, rewind, first, second } = await setup()
    const other = `${file}.other`
    writeFileSync(other, "original other")
    await rewind.mutate(
      [{ path: other, after: Buffer.from("changed other") }],
      async () => writeFileSync(other, "changed other"),
      { sessionId: store.id, toolCallId: "other", turnId: "turn" },
    )
    const append = store.appendDurable.bind(store)
    const race = spyOn(store, "appendDurable").mockImplementation((entry) => {
      const id = append(entry)
      if (entry.type === "file_restore") {
        writeFileSync(file, "first")
        writeFileSync(other, "external other")
      }
      return id
    })
    try {
      expect(() => rewind.restore(second, store.get(second)!.parentId)).toThrow("nothing changed")
    } finally {
      race.mockRestore()
    }
    store.append({ type: "checkout", target: store.get(second)!.parentId })
    const selected = fork ? store.fork() : SessionStore.open(store.file)
    if (fork) copyFileHistory(store, selected)
    const recorder = new FileRewind(selected)
    expect(recorder.plan(first).conflicts).toEqual([file])
    expect(() => recorder.restore(first, null)).toThrow("nothing changed")
    expect(readFileSync(file, "utf8")).toBe("first")
    expect(readFileSync(other, "utf8")).toBe("external other")
  })

  test(`a validated pre-gap observation retires only gaps after its target (fork: ${fork})`, async () => {
    const { file, store, rewind, write, first, second } = await setup()
    writeFileSync(file, "external gap")
    store.appendMessage(userMessage("third"))
    await write(rewind, "third")
    writeFileSync(file, "first")
    expect(rewind.plan(second)).toMatchObject({ restored: 0, conflicts: [] })
    rewind.restore(second, store.get(second)!.parentId)
    const selected = fork ? store.fork() : SessionStore.open(store.file)
    if (fork) copyFileHistory(store, selected)
    const recorder = new FileRewind(selected)
    expect(recorder.plan(first).conflicts).toEqual([])
    recorder.restore(first, null)
    expect(readFileSync(file, "utf8")).toBe("original")
  })
}

test("an older fork with a missing restore reference fails closed instead of inventing disk state", async () => {
  const { file, store, rewind, first } = await setup()
  store.appendDurable({ type: "file_restore_end", restoreId: "missing" })
  expect(() => rewind.plan(first)).toThrow("File history is incomplete")
  expect(() => rewind.restore(first, null)).toThrow("File history is incomplete")
  expect(readFileSync(file, "utf8")).toBe("second")
})

test("a replacement write after a skipped restore uses the observed target as its expected pre-image", async () => {
  const { file, store, rewind, write, first, second } = await setup()
  writeFileSync(file, "first")
  rewind.restore(second, store.get(second)!.parentId)
  const replacement = store.appendMessage(userMessage("replacement"))
  await write(rewind, "replacement")
  expect(rewind.plan(first).conflicts).toEqual([])
  rewind.restore(replacement, store.get(replacement)!.parentId)
  const forked = store.fork()
  copyFileHistory(store, forked)
  const recorder = new FileRewind(SessionStore.open(forked.file))
  expect(recorder.plan(first).conflicts).toEqual([])
  recorder.restore(first, null)
  expect(readFileSync(file, "utf8")).toBe("original")
})

test("recovery rechecks a skipped file before restoring any remaining file", async () => {
  const { file, store, rewind, first, second } = await setup()
  writeFileSync(file, "first")
  const other = `${file}.other`
  writeFileSync(other, "original other")
  await rewind.mutate(
    [{ path: other, after: Buffer.from("changed other") }],
    async () => writeFileSync(other, "changed other"),
    { sessionId: store.id, toolCallId: "other", turnId: "turn" },
  )
  const append = store.appendDurable.bind(store)
  const crash = spyOn(store, "appendDurable").mockImplementation((entry) => {
    const id = append(entry)
    if (entry.type === "file_restore") throw new Error("crash after authorization")
    return id
  })
  try {
    expect(() => rewind.restore(second, store.get(second)!.parentId)).toThrow("crash after authorization")
  } finally {
    crash.mockRestore()
  }
  writeFileSync(file, "second")
  const resumed = new FileRewind(SessionStore.open(store.file))
  expect(() => resumed.recover()).toThrow("nothing changed")
  expect(readFileSync(file, "utf8")).toBe("second")
  expect(readFileSync(other, "utf8")).toBe("changed other")
  expect(resumed.store.restore().messages).toEqual([userMessage("first"), userMessage("second")])
  expect(resumed.plan(first).conflicts).toEqual([file])
})
