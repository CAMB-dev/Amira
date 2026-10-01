import { expect, spyOn, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { userMessage } from "@amira/ai"
import { artifactDir } from "../src/artifacts.ts"
import { deleteSession, listSessions, sessionSnippet } from "../src/session-list.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"

const tmp = () => mkdtempSync(path.join(tmpdir(), "amira-management-"))
const reply = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  model: { provider: "p", model: "m" },
})

test("old sessions restore; titles survive checkout, manual names beat later auto entries", () => {
  const s = SessionStore.create({ cwd: "/project", dir: tmp() })
  const first = s.appendMessage(userMessage("hello"))
  expect(SessionStore.open(s.file).title).toBeUndefined()
  s.rename("Automatic", "auto")
  s.rename("My title")
  s.rename("Late automatic", "auto")
  s.append({ type: "title", source: "auto", title: "Foreign late auto" })
  s.append({ type: "checkout", target: first })
  s.rename("Last manual")
  const loaded = SessionStore.open(s.file)
  expect(loaded.title).toBe("Last manual")
  expect(loaded.restore().messages).toEqual([userMessage("hello")])
  s.rename(" \n ")
  expect(SessionStore.open(s.file).title).toBe("Foreign late auto")
  expect(listSessions("/project", path.dirname(s.file))[0]?.title).toBe("Foreign late auto")
})

test("a cleared manual name reveals the latest automatic title after reload", () => {
  const s = SessionStore.create({ cwd: "/project", dir: tmp() })
  s.appendMessage(userMessage("hello"))
  s.rename("Automatic", "auto")
  s.rename("Manual")
  expect(s.title).toBe("Manual")
  s.rename("")
  expect(s.title).toBe("Automatic")
  expect(SessionStore.open(s.file).title).toBe("Automatic")
})

test("title entries written before the source field remain readable", () => {
  const dir = tmp()
  const s = SessionStore.create({ cwd: "/project", dir })
  s.appendMessage(userMessage("hello"))
  s.rename("Legacy name")
  const legacy = path.join(dir, "legacy.jsonl")
  writeFileSync(legacy, readFileSync(s.file, "utf8").replace(',"source":"manual"', ""))
  expect(SessionStore.open(legacy).title).toBe("Legacy name")
})

test("an older Amira that skips title and usage entries rebuilds the same branch after a rewind", () => {
  const s = SessionStore.create({ cwd: "/project", dir: tmp() })
  s.appendMessage(userMessage("one"))
  s.appendMessage(reply("answer"))
  s.append({
    type: "side_usage",
    model: { provider: "p", model: "m" },
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  })
  s.rename("Named", "auto")
  const before = s.leafId
  s.appendMessage(userMessage("two"))
  s.append({ type: "checkout", target: before })
  s.appendMessage(userMessage("three"))
  // What an older reader keeps: every line but the entry types it does not know.
  const old = path.join(path.dirname(s.file), "old.jsonl")
  const lines = readFileSync(s.file, "utf8").split("\n")
  writeFileSync(old, lines.filter((l) => !/"type":"(title|side_usage)"/.test(l)).join("\n"))
  expect(SessionStore.open(old).restore().messages).toEqual(s.restore().messages)
  expect(s.restore().messages).toEqual([userMessage("one"), reply("answer"), userMessage("three")])
  expect(SessionStore.open(s.file).title).toBe("Named")
})

test("content search includes later assistant and user text, CJK and reuses the summary cache", () => {
  const dir = tmp()
  const s = SessionStore.create({ cwd: "/project", dir })
  s.appendMessage(userMessage("First prompt"))
  s.appendMessage(reply("The answer contains 数据库连接 and NEEDLE."))
  s.appendMessage(userMessage("Later user text"))
  const open = spyOn(SessionStore, "open")
  try {
    const first = listSessions("/project", dir)[0]!
    expect(sessionSnippet(first.searchText, "数据库连接")).toContain("数据库连接")
    expect(sessionSnippet(first.searchText, "needle")).toContain("NEEDLE")
    expect(sessionSnippet(first.searchText, "later USER")).toContain("Later user")
    expect(listSessions("/project", dir)[0]).toBe(first)
    expect(open).toHaveBeenCalledTimes(1)
    s.appendMessage(reply("new content"))
    expect(listSessions("/project", dir)[0]).not.toBe(first)
    expect(open).toHaveBeenCalledTimes(2)
  } finally {
    open.mockRestore()
  }
})

test("hundreds of sessions are parsed once, not once per search keystroke", () => {
  const dir = tmp()
  for (let i = 0; i < 200; i++)
    SessionStore.create({ cwd: "/project", dir }).appendMessage(userMessage(`prompt ${i}`))
  const open = spyOn(SessionStore, "open")
  try {
    expect(listSessions("/project", dir)).toHaveLength(200)
    for (const query of ["p", "pr", "pro"]) {
      expect(listSessions("/project", dir).filter((s) => sessionSnippet(s.searchText, query))).toHaveLength(
        200,
      )
    }
    expect(open).toHaveBeenCalledTimes(200)
  } finally {
    open.mockRestore()
  }
})

test("fork keeps the prefix and compaction references, records parent and leaves the original bytes unchanged", () => {
  const s = SessionStore.create({ cwd: "/project", dir: tmp() })
  const first = s.appendMessage(userMessage("one"))
  s.appendMessage(reply("answer"))
  const compact = s.append({ type: "compaction", summary: "summary", replaces: [first] })
  s.appendMessage(userMessage("two"))
  s.rename("Original")
  const before = readFileSync(s.file, "utf8")
  const fork = s.fork(compact)
  const loaded = SessionStore.open(fork.file)
  expect(loaded.header.parent).toBe(s.id)
  expect(loaded.title).toBe("Original (fork)")
  expect(loaded.restore().messages).toEqual(s.restore().messages.slice(0, -1))
  expect(loaded.compacted(compact)).toEqual([userMessage("one")])
  expect(
    loaded.entries.some(
      (e) =>
        e.type === "message" &&
        e.message.role === "user" &&
        e.message.content.some((b) => b.type === "text" && b.text === "two"),
    ),
  ).toBe(false)
  expect(readFileSync(s.file, "utf8")).toBe(before)
  expect(s.fork(null).restore().messages).toEqual([])
  expect(() => s.fork("missing")).toThrow("unknown entry")
})

test("fork copies only the current branch after an abandoned rewind", () => {
  const s = SessionStore.create({ cwd: "/project", dir: tmp() })
  const first = s.appendMessage(userMessage("first"))
  const abandoned = s.appendMessage(userMessage("abandoned"))
  s.append({ type: "checkout", target: first })
  const current = s.appendMessage(userMessage("current"))
  const fork = s.fork()

  expect(fork.restore().messages).toEqual([userMessage("first"), userMessage("current")])
  expect(fork.entries.some((e) => e.id === abandoned)).toBe(false)
  expect(fork.entries.some((e) => e.id === current)).toBe(true)
})

test("delete refuses the current session and traversal; removes owned children but preserves shared fork children", () => {
  const dir = tmp()
  const s = SessionStore.create({ cwd: "/project", dir })
  s.appendMessage(userMessage("parent"))
  const child = SessionStore.create({ cwd: "/project", dir: path.join(dir, "subagents") })
  child.appendMessage(userMessage("child"))
  s.append({ type: "subagent", childSessionId: child.id, role: "explorer" })
  const fork = s.fork()
  expect(() => deleteSession("/project", s.id, s.id, dir)).toThrow("current")
  expect(() => deleteSession("/project", "../outside", undefined, dir)).toThrow("no session")
  deleteSession("/project", s.id, fork.id, dir)
  expect(existsSync(s.file)).toBe(false)
  expect(existsSync(child.file)).toBe(true)
  deleteSession("/project", fork.id, undefined, dir)
  expect(existsSync(child.file)).toBe(false)
  expect(listSessions("/project", dir)).toEqual([])
})

test("delete removes the saved artifacts of the session and of its sub-agents", () => {
  const dir = tmp()
  const s = SessionStore.create({ cwd: "/project", dir })
  s.appendMessage(userMessage("parent"))
  const child = SessionStore.create({ cwd: "/project", dir: path.join(dir, "subagents") })
  child.appendMessage(userMessage("child"))
  s.append({ type: "subagent", childSessionId: child.id, role: "explorer" })
  const outputs = [artifactDir(s.file, s.id), artifactDir(child.file, child.id)]
  for (const out of outputs) {
    mkdirSync(out, { recursive: true })
    writeFileSync(path.join(out, "a_1.txt"), "saved output")
  }
  deleteSession("/project", s.id, undefined, dir)
  for (const out of outputs) expect(existsSync(path.dirname(out))).toBe(false)
})

test("delete refuses a live session lease, then takes over a stale crash lease", () => {
  const dir = tmp()
  const s = SessionStore.create({ cwd: "/project", dir })
  s.appendMessage(userMessage("to delete"))
  const lock = sessionLockFile(s.file)
  writeFileSync(lock, `${process.ppid}\n`)
  expect(() => deleteSession("/project", s.id, undefined, dir)).toThrow("open in another Amira process")
  expect(existsSync(s.file)).toBe(true)

  utimesSync(lock, new Date(0), new Date(0))
  deleteSession("/project", s.id, undefined, dir)
  expect(existsSync(s.file)).toBe(false)
  rmSync(lock, { force: true })
})

test("untrusted sub-agent ids cannot cause files outside the session directory to be removed", () => {
  const s = SessionStore.create({ cwd: "/project", dir: tmp() })
  s.appendMessage(userMessage("parent"))
  s.append({ type: "subagent", childSessionId: "../../outside", role: "explorer" })
  expect(() => deleteSession("/project", s.id, undefined, path.dirname(s.file))).toThrow("unsafe")
  expect(existsSync(s.file)).toBe(true)
})

test("delete refuses a symlinked child directory before removing anything", () => {
  const dir = tmp()
  const external = tmp()
  const s = SessionStore.create({ cwd: "/project", dir })
  const child = SessionStore.create({ cwd: "/project", dir: external })
  child.appendMessage(userMessage("must stay"))
  s.appendMessage(userMessage("parent"))
  s.append({ type: "subagent", childSessionId: child.id, role: "explorer" })
  symlinkSync(external, path.join(dir, "subagents"), process.platform === "win32" ? "junction" : "dir")
  expect(() => deleteSession("/project", s.id, undefined, dir)).toThrow("symlink")
  expect(existsSync(s.file)).toBe(true)
  expect(existsSync(child.file)).toBe(true)
})

test("a damaged or unsafe unrelated session does not block deleting another", () => {
  const dir = tmp()
  const s = SessionStore.create({ cwd: "/project", dir })
  s.appendMessage(userMessage("to delete"))
  const bad = SessionStore.create({ cwd: "/project", dir })
  bad.appendMessage(userMessage("other"))
  bad.append({ type: "subagent", childSessionId: "../../outside", role: "explorer" })
  writeFileSync(path.join(dir, "junk.jsonl"), "not json\n")
  deleteSession("/project", s.id, undefined, dir)
  expect(existsSync(s.file)).toBe(false)
  expect(existsSync(bad.file)).toBe(true)
})
