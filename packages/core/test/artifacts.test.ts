import { afterAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSessionArtifacts } from "../src/agent/setup.ts"
import { ArtifactQuotaError, ArtifactStore, artifactDir, referencedArtifacts } from "../src/artifacts.ts"
import { SessionStore } from "../src/session-store.ts"

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function tempDir() {
  const d = await mkdtemp(path.join(os.tmpdir(), "amira-artifacts-"))
  dirs.push(d)
  return d
}

test("an artifact is a text file and its metadata; it is found by id, also by a new store", async () => {
  const dir = path.join(await tempDir(), "outputs")
  const store = new ArtifactStore({ dir, storageRoot: path.dirname(dir), sessionId: "s_1" })
  const text = "第一行\r\nline 2\n😀 three\n"
  const a = await store.save({ text, tool: "bash", toolCallId: "c1" })
  expect(a.id).toMatch(/^a_[0-9a-f]{10}$/)
  expect(readFileSync(a.path, "utf8")).toBe(text)
  expect(a).toMatchObject({ tool: "bash", toolCallId: "c1", sessionId: "s_1", lines: 3, complete: true })
  expect(a.chars).toBe(text.length)
  expect(a.bytes).toBe(Buffer.byteLength(text))
  expect(store.find(a.id)).toEqual(a)
  // Nothing half-written is left behind.
  expect(readdirSync(dir).sort()).toEqual([`${a.id}.json`, `${a.id}.txt`])
  // A resumed session (a new store on the same directory) finds it and counts it.
  const again = new ArtifactStore({ dir, storageRoot: path.dirname(dir), sessionId: "s_1" })
  expect(again.find(a.id)?.chars).toBe(text.length)
  expect(again.used).toBe(a.bytes)
  expect(again.list().map((x) => x.id)).toEqual([a.id])
  // Ids are checked: nothing outside the directory is looked up.
  expect(store.find("../../etc/passwd")).toBeUndefined()
  expect(store.find("a_0000000000")).toBeUndefined()
  const cut = await store.save({ text: "partial", tool: "bash", incomplete: "the command was aborted" })
  expect(cut).toMatchObject({ complete: false, incomplete: "the command was aborted" })
})

test("a lazy session can create its storage root when saving its first artifact", async () => {
  const root = await tempDir()
  const storage = path.join(root, "new", "sessions")
  const session = SessionStore.create({ cwd: root, dir: storage })
  const store = createSessionArtifacts({ session }, session.id, {})
  expect(existsSync(storage)).toBe(false)
  const saved = await store.save({ text: "first output", tool: "bash" })
  expect(readFileSync(saved.path, "utf8")).toBe("first output")
  expect(path.dirname(saved.path)).toBe(await realpath(artifactDir(session.file, session.id)))
})

for (const level of ["assets", "outputs"]) {
  test(`an ${level} junction/symlink cannot redirect text artifacts outside session storage`, async () => {
    const root = await tempDir()
    const storage = path.join(root, "sessions")
    const outside = path.join(root, "sessions-outside")
    await mkdir(storage)
    await mkdir(outside)
    const dir = artifactDir(path.join(storage, "s.jsonl"), "s")
    const assets = path.dirname(dir)
    if (level === "outputs") await mkdir(assets)
    await symlink(
      outside,
      level === "outputs" ? dir : assets,
      process.platform === "win32" ? "junction" : "dir",
    )
    const store = new ArtifactStore({ dir, storageRoot: storage, sessionId: "s" })
    await expect(store.save({ text: "private output", tool: "bash" })).rejects.toThrow(
      "escapes session storage",
    )
    expect(readdirSync(outside)).toEqual([])
    expect(store.used).toBe(0)
  })

  test(`save and prune revalidate a replaced ${level} directory`, async () => {
    const root = await tempDir()
    const storage = path.join(root, "sessions")
    const outside = path.join(root, "sessions-outside")
    await mkdir(storage)
    await mkdir(outside)
    const dir = artifactDir(path.join(storage, "s.jsonl"), "s")
    const store = new ArtifactStore({ dir, storageRoot: storage, sessionId: "s" })
    const saved = await store.save({ text: "original", tool: "bash" })
    const replaced = level === "outputs" ? dir : path.dirname(dir)
    await rename(replaced, `${replaced}.original`)
    await symlink(outside, replaced, process.platform === "win32" ? "junction" : "dir")
    const target = level === "outputs" ? outside : path.join(outside, "outputs")
    await mkdir(target, { recursive: true })
    const metadata = path.join(target, `${saved.id}.json`)
    const text = path.join(target, `${saved.id}.txt`)
    await writeFile(metadata, "untouched metadata")
    await writeFile(text, "untouched text")
    await expect(store.save({ text: "redirected", tool: "bash" })).rejects.toThrow("escapes session storage")
    await expect(store.prune([saved.id])).rejects.toThrow("escapes session storage")
    expect(readFileSync(metadata, "utf8")).toBe("untouched metadata")
    expect(readFileSync(text, "utf8")).toBe("untouched text")
    expect(readdirSync(target).sort()).toEqual([`${saved.id}.json`, `${saved.id}.txt`])
    expect(store.used).toBe(saved.bytes)
    expect(store.find(saved.id)?.pruned).toBeUndefined()
  })

  test(`an in-root ${level} alias still saves, resumes and prunes text artifacts`, async () => {
    const storage = await realpath(await tempDir())
    const actual = path.join(storage, "actual")
    await mkdir(actual)
    const dir = artifactDir(path.join(storage, "s.jsonl"), "s")
    const assets = path.dirname(dir)
    if (level === "outputs") await mkdir(assets)
    await symlink(
      actual,
      level === "outputs" ? dir : assets,
      process.platform === "win32" ? "junction" : "dir",
    )
    const store = new ArtifactStore({ dir, storageRoot: storage, sessionId: "s", quotaBytes: 10 })
    const saved = await store.save({ text: "output", tool: "bash" })
    expect(saved.path).toBe(await realpath(saved.path))
    expect(readFileSync(saved.path, "utf8")).toBe("output")
    const resumed = new ArtifactStore({ dir, storageRoot: storage, sessionId: "s", quotaBytes: 10 })
    expect(resumed.used).toBe(6)
    await expect(resumed.save({ text: "output", tool: "bash" })).rejects.toBeInstanceOf(ArtifactQuotaError)
    expect(await resumed.prune([saved.id])).toEqual({ removed: 1, bytes: 6 })
    expect(existsSync(saved.path)).toBe(false)
    expect(resumed.find(saved.id)?.pruned).toBeDefined()
    await resumed.save({ text: "output", tool: "bash" })
  })
}

test("the quota is checked before writing; a failing disk leaves nothing behind", async () => {
  const root = await tempDir()
  const store = new ArtifactStore({
    dir: path.join(root, "q"),
    storageRoot: root,
    sessionId: "s",
    quotaBytes: 100,
  })
  await store.save({ text: "x".repeat(60), tool: "t" })
  await expect(store.save({ text: "y".repeat(60), tool: "t" })).rejects.toBeInstanceOf(ArtifactQuotaError)
  expect(readdirSync(path.join(root, "q"))).toHaveLength(2)
  // A file where the directory should be.
  writeFileSync(path.join(root, "blocked"), "x")
  const broken = new ArtifactStore({
    dir: path.join(root, "blocked", "outputs"),
    storageRoot: root,
    sessionId: "s",
  })
  await expect(broken.save({ text: "z", tool: "t" })).rejects.toThrow()
  expect(broken.used).toBe(0)
})

test("pruning deletes the text, keeps the metadata marked, and frees the quota", async () => {
  const dir = path.join(await tempDir(), "p")
  const store = new ArtifactStore({ dir, storageRoot: path.dirname(dir), sessionId: "s", quotaBytes: 100 })
  const a = await store.save({ text: "x".repeat(60), tool: "t" })
  expect(await store.prune([a.id, "a_ffffffffff"])).toEqual({ removed: 1, bytes: 60 })
  expect(existsSync(a.path)).toBe(false)
  expect(store.find(a.id)?.pruned).toBeDefined()
  expect(
    new ArtifactStore({ dir, storageRoot: path.dirname(dir), sessionId: "s" }).find(a.id)?.pruned,
  ).toBeDefined()
  expect(store.exists(a)).toBe(false)
  // Pruning again changes nothing; the space is free again.
  expect(await store.prune([a.id])).toEqual({ removed: 0, bytes: 0 })
  await store.save({ text: "y".repeat(60), tool: "t" })
})

test("a child's store finds its parent's artifacts; where artifacts live", async () => {
  const root = await tempDir()
  const parent = new ArtifactStore({ dir: path.join(root, "parent"), storageRoot: root, sessionId: "s_p" })
  const child = new ArtifactStore({
    dir: path.join(root, "child"),
    storageRoot: root,
    sessionId: "s_c",
    parent,
  })
  const a = await parent.save({ text: "from the parent", tool: "grep" })
  expect(child.find(a.id)?.sessionId).toBe("s_p")
  const b = await child.save({ text: "own", tool: "grep" })
  expect(parent.find(b.id)).toBeUndefined()
  expect(artifactDir(path.join(root, "s_x.jsonl"), "s_x")).toBe(path.join(root, "s_x.assets", "outputs"))
  expect(artifactDir(undefined, "s_y")).toBe(path.join(os.tmpdir(), "amira", "outputs", "s_y"))
})

test("owned resolution rejects oversized metadata before parsing, including a resumed store", async () => {
  const storageRoot = await tempDir()
  const dir = path.join(storageRoot, "s.assets", "outputs")
  const store = new ArtifactStore({ dir, storageRoot, sessionId: "s" })
  const saved = await store.save({ text: "x", tool: "test" })
  await writeFile(
    path.join(dir, `${saved.id}.json`),
    JSON.stringify({ ...saved, tool: "x".repeat(9 * 1024 * 1024) }),
  )
  const resumed = new ArtifactStore({ dir, storageRoot, sessionId: "s" })
  await expect(resumed.resolveOwned(saved.id)).rejects.toThrow("metadata")
  await expect(store.resolveOwned(saved.id)).rejects.toThrow("metadata")
})

test("owned resolution rejects directory metadata without trying to parse it", async () => {
  const storageRoot = await tempDir()
  const dir = path.join(storageRoot, "s.assets", "outputs")
  const id = "a_1234567890"
  await mkdir(path.join(dir, `${id}.json`), { recursive: true })
  const store = new ArtifactStore({ dir, storageRoot, sessionId: "s" })
  await expect(store.resolveOwned(id)).rejects.toThrow("metadata")
})

test.skipIf(process.platform === "win32")(
  "owned resolution rejects FIFO metadata without blocking",
  async () => {
    const storageRoot = await tempDir()
    const dir = path.join(storageRoot, "s.assets", "outputs")
    const id = "a_1234567890"
    await mkdir(dir, { recursive: true })
    const fifo = path.join(dir, `${id}.json`)
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0)
    const store = new ArtifactStore({ dir, storageRoot, sessionId: "s" })
    await expect(store.resolveOwned(id)).rejects.toThrow("metadata")
  },
)

test("owned resolution rejects a directory alias installed between metadata inspection and open", async () => {
  const root = await tempDir()
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "artifact-metadata-race-worker.ts"), root],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toBe("")
  expect(code).toBe(0)
})

for (const level of ["assets", "outputs"]) {
  test(`owned resolution rejects a same-storage-root cross-session ${level} alias`, async () => {
    const storageRoot = await tempDir()
    const other = path.join(storageRoot, "other.assets", "outputs")
    const parent = new ArtifactStore({ dir: other, storageRoot, sessionId: "other" })
    const saved = await parent.save({ text: "private", tool: "test" })
    const dir = path.join(storageRoot, "s.assets", "outputs")
    if (level === "outputs") await mkdir(path.dirname(dir))
    await symlink(
      level === "assets" ? path.dirname(other) : other,
      level === "assets" ? path.dirname(dir) : dir,
      process.platform === "win32" ? "junction" : "dir",
    )
    const store = new ArtifactStore({ dir, storageRoot, sessionId: "s" })
    await expect(store.resolveOwned(saved.id)).rejects.toThrow("alias")
  })
}

test("owned resolution preserves inherited artifacts for lazy, resumed and private child stores", async () => {
  const storageRoot = await realpath(await tempDir())
  const parentDir = path.join(storageRoot, "parent.assets", "outputs")
  const original = new ArtifactStore({ dir: parentDir, storageRoot, sessionId: "parent" })
  const saved = await original.save({ text: "inherited", tool: "test" })
  const parent = new ArtifactStore({ dir: parentDir, storageRoot, sessionId: "parent" })
  for (const readOnly of [false, true]) {
    const dir = path.join(storageRoot, `child-${readOnly}.assets`, "outputs")
    const child = new ArtifactStore({ dir, storageRoot, sessionId: "child", parent, readOnly })
    expect(await child.resolveOwned(saved.id)).toEqual({ path: saved.path, root: parentDir })
    await mkdir(dir, { recursive: true })
    expect(await child.resolveOwned(saved.id)).toEqual({ path: saved.path, root: parentDir })
  }
})

test("references are found on every branch of a session file and in its sub-agents' files", async () => {
  const dir = await tempDir()
  const session = SessionStore.create({ cwd: dir, dir })
  session.appendMessage({ role: "user", content: [{ type: "text", text: "see a_1111111111" }] })
  const tip = session.leafId
  session.appendMessage({ role: "user", content: [{ type: "text", text: "and a_2222222222" }] })
  session.append({ type: "checkout", target: tip })
  session.append({ type: "subagent", childSessionId: "s_child", role: "" })
  await mkdir(path.join(dir, "subagents"), { recursive: true })
  await writeFile(
    path.join(dir, "subagents", "s_child.jsonl"),
    `${JSON.stringify({ type: "session", v: 1, id: "s_child" })}\n${JSON.stringify({ type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: "a_3333333333" }] } })}\nnot json\n`,
  )
  expect([...referencedArtifacts(session)].sort()).toEqual(["a_1111111111", "a_2222222222", "a_3333333333"])
})
