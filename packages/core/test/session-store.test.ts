import { expect, test } from "bun:test"
import { appendFileSync, existsSync, readFileSync, utimesSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { type Message, userMessage } from "@amira/ai"
import { findSession, listSessions } from "../src/session-list.ts"
import { SessionStore, sessionsDir } from "../src/session-store.ts"

const tmp = () => mkdtemp(path.join(os.tmpdir(), "amira-sessions-"))

const reply = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  model: { provider: "p", model: "m" },
})

function lines(file: string) {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
}

test("nothing is written until the first message", async () => {
  const dir = await tmp()
  const s = SessionStore.create({ cwd: "/proj", dir })
  s.append({ type: "model_change", model: { provider: "p", model: "m" } })
  expect(existsSync(s.file)).toBe(false)
  s.appendMessage(userMessage("hi"))
  const [header, change, msg] = lines(s.file)
  expect(header).toMatchObject({ type: "session", v: 1, id: s.id, cwd: "/proj", parent: null })
  expect(change).toMatchObject({ type: "model_change", parentId: null })
  expect(msg).toMatchObject({ type: "message", parentId: change.id, message: userMessage("hi") })
})

test("reopening restores the branch; appends continue the chain", async () => {
  const dir = await tmp()
  const s = SessionStore.create({ cwd: "/proj", dir })
  s.appendMessage(userMessage("one"))
  s.appendMessage(reply("two"))
  const again = SessionStore.open(s.file)
  expect(again.restore().messages).toEqual([userMessage("one"), reply("two")])
  again.appendMessage(userMessage("three"))
  expect(SessionStore.open(s.file).restore().messages.length).toBe(3)
})

test("checkout switches the branch without rewriting anything", async () => {
  const dir = await tmp()
  const s = SessionStore.create({ cwd: "/proj", dir })
  const a = s.appendMessage(userMessage("a"))
  s.appendMessage(reply("b"))
  s.append({ type: "checkout", target: a })
  s.appendMessage(reply("c"))
  const texts = (st: SessionStore) =>
    st.restore().messages.map((m) => (m.content[0] as { text: string }).text)
  expect(texts(s)).toEqual(["a", "c"])
  const reopened = SessionStore.open(s.file)
  expect(texts(reopened)).toEqual(["a", "c"])
  expect(reopened.entries.length).toBe(4)
  expect(() => s.append({ type: "checkout", target: "nope" })).toThrow(/unknown entry/)
})

test("a torn last line is ignored and the next write starts a fresh line", async () => {
  const dir = await tmp()
  const s = SessionStore.create({ cwd: "/proj", dir })
  s.appendMessage(userMessage("a"))
  appendFileSync(s.file, '{"type":"message","id":"e_torn","parentId')
  const reopened = SessionStore.open(s.file)
  expect(reopened.restore().messages).toEqual([userMessage("a")])
  reopened.appendMessage(reply("b"))
  const final = SessionStore.open(s.file)
  expect(final.restore().messages).toEqual([userMessage("a"), reply("b")])
})

test("compaction entries replace messages with a summary pair on restore", async () => {
  const dir = await tmp()
  const s = SessionStore.create({ cwd: "/proj", dir })
  const ids = [s.appendMessage(userMessage("old")), s.appendMessage(reply("old reply"))]
  s.appendMessage(userMessage("recent"))
  s.append({ type: "compaction", summary: "they said old", replaces: ids })
  s.appendMessage(reply("after"))
  const { messages } = s.restore()
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
  expect((messages[0]!.content[0] as { text: string }).text).toContain("they said old")
  expect(messages[2]).toEqual(userMessage("recent"))
  // The originals stay in the file.
  expect(s.entries.filter((e) => e.type === "message").length).toBe(4)
})

test("a second compaction can replace the first summary", async () => {
  const dir = await tmp()
  const s = SessionStore.create({ cwd: "/proj", dir })
  const a = s.appendMessage(userMessage("a"))
  s.appendMessage(userMessage("b"))
  const c1 = s.append({ type: "compaction", summary: "S1", replaces: [a] })
  s.appendMessage(userMessage("c"))
  s.append({ type: "compaction", summary: "S2", replaces: [c1, s.entries[1]!.id] })
  const texts = s.restore().messages.map((m) => (m.content[0] as { text: string }).text)
  expect(texts.length).toBe(3)
  expect(texts[0]).toContain("S2")
  expect(texts[2]).toBe("c")
})

test("lists sessions newest first with their first user text", async () => {
  const dir = await tmp()
  const a = SessionStore.create({ cwd: "/proj", dir })
  a.appendMessage(userMessage("first  question\nwith lines"))
  a.appendMessage(reply("x"))
  const b = SessionStore.create({ cwd: "/proj", dir })
  b.appendMessage(userMessage("second"))
  utimesSync(a.file, new Date(1000), new Date(1000))
  const list = listSessions("/proj", dir)
  expect(list.map((s) => s.id)).toEqual([b.id, a.id])
  expect(list[1]).toMatchObject({ firstUserText: "first question with lines", messageCount: 2 })
  expect(findSession("/proj", a.id, dir)).toBe(a.file)
  expect(findSession("/proj", "../evil", dir)).toBeUndefined()
  expect(listSessions("/proj", path.join(dir, "missing"))).toEqual([])
})

test("session directories are per working directory", () => {
  expect(sessionsDir("/a")).not.toBe(sessionsDir("/b"))
  expect(sessionsDir("/a")).toBe(sessionsDir("/a/"))
})
