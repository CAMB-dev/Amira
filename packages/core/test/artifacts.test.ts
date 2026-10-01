import { afterAll, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
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
  const store = new ArtifactStore({ dir, sessionId: "s_1" })
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
  const again = new ArtifactStore({ dir, sessionId: "s_1" })
  expect(again.find(a.id)?.chars).toBe(text.length)
  expect(again.used).toBe(a.bytes)
  expect(again.list().map((x) => x.id)).toEqual([a.id])
  // Ids are checked: nothing outside the directory is looked up.
  expect(store.find("../../etc/passwd")).toBeUndefined()
  expect(store.find("a_0000000000")).toBeUndefined()
  const cut = await store.save({ text: "partial", tool: "bash", incomplete: "the command was aborted" })
  expect(cut).toMatchObject({ complete: false, incomplete: "the command was aborted" })
})

test("the quota is checked before writing; a failing disk leaves nothing behind", async () => {
  const root = await tempDir()
  const store = new ArtifactStore({ dir: path.join(root, "q"), sessionId: "s", quotaBytes: 100 })
  await store.save({ text: "x".repeat(60), tool: "t" })
  await expect(store.save({ text: "y".repeat(60), tool: "t" })).rejects.toBeInstanceOf(ArtifactQuotaError)
  expect(readdirSync(path.join(root, "q"))).toHaveLength(2)
  // A file where the directory should be.
  writeFileSync(path.join(root, "blocked"), "x")
  const broken = new ArtifactStore({ dir: path.join(root, "blocked", "outputs"), sessionId: "s" })
  await expect(broken.save({ text: "z", tool: "t" })).rejects.toThrow()
  expect(broken.used).toBe(0)
})

test("pruning deletes the text, keeps the metadata marked, and frees the quota", async () => {
  const dir = path.join(await tempDir(), "p")
  const store = new ArtifactStore({ dir, sessionId: "s", quotaBytes: 100 })
  const a = await store.save({ text: "x".repeat(60), tool: "t" })
  expect(await store.prune([a.id, "a_ffffffffff"])).toEqual({ removed: 1, bytes: 60 })
  expect(existsSync(a.path)).toBe(false)
  expect(store.find(a.id)?.pruned).toBeDefined()
  expect(new ArtifactStore({ dir, sessionId: "s" }).find(a.id)?.pruned).toBeDefined()
  expect(store.exists(a)).toBe(false)
  // Pruning again changes nothing; the space is free again.
  expect(await store.prune([a.id])).toEqual({ removed: 0, bytes: 0 })
  await store.save({ text: "y".repeat(60), tool: "t" })
})

test("a child's store finds its parent's artifacts; where artifacts live", async () => {
  const root = await tempDir()
  const parent = new ArtifactStore({ dir: path.join(root, "parent"), sessionId: "s_p" })
  const child = new ArtifactStore({ dir: path.join(root, "child"), sessionId: "s_c", parent })
  const a = await parent.save({ text: "from the parent", tool: "grep" })
  expect(child.find(a.id)?.sessionId).toBe("s_p")
  const b = await child.save({ text: "own", tool: "grep" })
  expect(parent.find(b.id)).toBeUndefined()
  expect(artifactDir(path.join(root, "s_x.jsonl"), "s_x")).toBe(path.join(root, "s_x.assets", "outputs"))
  expect(artifactDir(undefined, "s_y")).toBe(path.join(os.tmpdir(), "amira", "outputs", "s_y"))
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
