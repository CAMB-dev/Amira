import { expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { userMessage } from "@amira/ai"
import { deleteSession, listSessions, sessionSnippet } from "../src/session-list.ts"
import { SessionStore } from "../src/session-store.ts"

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
  expect(() => s.rename(" \n ")).toThrow("empty")
  expect(listSessions("/project", path.dirname(s.file))[0]?.title).toBe("Last manual")
})

test("an older Amira that skips title and usage entries rebuilds the same branch after a rewind", () => {
  const s = SessionStore.create({ cwd: "/project", dir: tmp() })
  s.appendMessage(userMessage("one"))
  s.appendMessage(reply("answer"))
  s.append({ type: "side_usage", model: { provider: "p", model: "m" }, usage: { input: 1, output: 1 } })
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
