import { expect, test } from "bun:test"
import { appendFileSync, chmodSync, existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { type Message, userMessage } from "@amira/ai"
import { findSession, listSessions } from "../src/session-list.ts"
import { SessionConflictError, SessionStore, sessionsDir } from "../src/session-store.ts"

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

test("a user message's display round-trips through the file and names the session in lists", async () => {
  const dir = await tmp()
  const s = SessionStore.create({ cwd: "/proj", dir })
  const display = { text: "/review-pr 123", note: "Loaded skill review-pr (120 lines)" }
  s.appendMessage(userMessage("Skill review-pr\n\nlong instructions", display))
  s.appendMessage(reply("ok"))
  expect(SessionStore.open(s.file).restore().messages[0]).toEqual({
    role: "user",
    content: [{ type: "text", text: "Skill review-pr\n\nlong instructions" }],
    display,
  })
  expect(listSessions("/proj", dir)[0]?.firstUserText).toBe("/review-pr 123")
})

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

test("a checkout to null goes back to before the first entry, in the same file", async () => {
  const dir = await tmp()
  const s = SessionStore.create({ cwd: "/proj", dir })
  s.appendMessage(userMessage("a"))
  s.appendMessage(reply("b"))
  s.append({ type: "checkout", target: null })
  expect(s.restore().messages).toEqual([])
  expect(s.leafId).toBeNull()
  s.appendMessage(userMessage("again"))
  const reopened = SessionStore.open(s.file)
  expect(reopened.id).toBe(s.id)
  expect(reopened.restore().messages).toEqual([userMessage("again")])
  expect(reopened.entries.length).toBe(4)
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

test("a failed write leaves no trace, so later entries still chain to the earlier ones", async () => {
  const dir = await tmp()
  const s = SessionStore.create({ cwd: "/proj", dir })
  s.appendMessage(userMessage("one"))
  s.appendMessage(reply("two"))
  chmodSync(s.file, 0o444)
  try {
    expect(() => s.appendMessage(userMessage("three"))).toThrow()
  } finally {
    chmodSync(s.file, 0o644)
  }
  s.appendMessage(userMessage("four"))
  const expected = [userMessage("one"), reply("two"), userMessage("four")]
  expect(s.restore().messages).toEqual(expected)
  expect(SessionStore.open(s.file).restore().messages).toEqual(expected)
})

test("the first write failing keeps buffered entries for the next attempt", async () => {
  const dir = await tmp()
  const blocker = path.join(dir, "blocked")
  writeFileSync(blocker, "")
  // The session directory cannot be created where a file already sits.
  const s = SessionStore.create({ cwd: "/proj", dir: blocker })
  s.append({ type: "model_change", model: { provider: "p", model: "m" } })
  expect(() => s.appendMessage(userMessage("lost"))).toThrow()
  expect(s.entries.length).toBe(1)
  expect(s.branch().map((e) => e.type)).toEqual(["model_change"])
})

test("a second writer to the same file is refused instead of interleaving chains", async () => {
  const dir = await tmp()
  const s = SessionStore.create({ cwd: "/proj", dir })
  s.appendMessage(userMessage("one"))
  const a = SessionStore.open(s.file)
  const b = SessionStore.open(s.file)
  a.appendMessage(userMessage("from a"))
  expect(() => b.appendMessage(userMessage("from b"))).toThrow(SessionConflictError)
  expect(() => b.appendMessage(userMessage("from b again"))).toThrow(SessionConflictError)
  a.appendMessage(reply("still a"))
  expect(SessionStore.open(s.file).restore().messages).toEqual([
    userMessage("one"),
    userMessage("from a"),
    reply("still a"),
  ])
})

test("a parent missing from the file is bridged to the entry before it", async () => {
  const dir = await tmp()
  const s = SessionStore.create({ cwd: "/proj", dir })
  s.appendMessage(userMessage("one"))
  s.appendMessage(reply("two"))
  appendFileSync(
    s.file,
    `${JSON.stringify({ type: "message", id: "e_orphan", parentId: "e_gone", ts: 0, message: userMessage("three") })}\n`,
  )
  const reopened = SessionStore.open(s.file)
  expect(reopened.restore().messages).toEqual([userMessage("one"), reply("two"), userMessage("three")])
  reopened.appendMessage(reply("four"))
  expect(SessionStore.open(s.file).restore().messages.length).toBe(4)
})

test("a checkout to an entry missing from the file is ignored", async () => {
  const dir = await tmp()
  const s = SessionStore.create({ cwd: "/proj", dir })
  s.appendMessage(userMessage("one"))
  appendFileSync(
    s.file,
    `${JSON.stringify({ type: "checkout", id: "e_co", parentId: null, ts: 0, target: "e_gone" })}\n`,
  )
  expect(SessionStore.open(s.file).restore().messages).toEqual([userMessage("one")])
})

test("server checkpoints, retained messages and fills restore; damaged fields are ignored", async () => {
  const dir = await tmp()
  const s = SessionStore.create({ cwd: "/proj", dir })
  const q1 = s.appendMessage(userMessage("q1"))
  const r1 = s.appendMessage(reply("r1"))
  const q2 = s.appendMessage(userMessage("q2"))
  const checkpoint = {
    dialect: "openai-responses",
    value: '{"type":"compaction","encrypted_content":"E"}',
    kind: "checkpoint" as const,
    provider: "p",
    host: "api.p.com",
    model: "m",
  }
  // The "recent-user" layout: everything replaced, the user messages kept before the checkpoint.
  const c = s.append({
    type: "compaction",
    summary: "",
    replaces: [q1, r1, q2],
    retained: [q1, q2],
    checkpoint,
    reason: "threshold",
    native: { provider: "p", model: "m" },
    layout: "recent-user",
  })
  let restored = SessionStore.open(s.file).restore()
  expect(restored.messages.map((m) => (m.content[0] as { text: string }).text)).toEqual([
    "q1",
    "q2",
    "The earlier part of this conversation was compacted. Summary:\n\n",
    "Understood. I will continue from this summary.",
  ])
  expect((restored.messages[2]!.content[0] as { signature?: unknown }).signature).toEqual(checkpoint)
  expect(restored.compactions.get(restored.messages[2]!)).toEqual({
    reason: "threshold",
    native: { provider: "p", model: "m" },
    layout: "recent-user",
  })
  // A text summary written for it later replaces it in place and keeps the checkpoint.
  s.append({ type: "compaction", summary: "TEXT", replaces: [c], retained: [q1, q2], checkpoint, fills: c })
  restored = SessionStore.open(s.file).restore()
  expect(restored.messages.map((m) => (m.content[0] as { text: string }).text)[2]).toContain("TEXT")
  expect(restored.messages).toHaveLength(4)
  const texts = SessionStore.open(s.file)
    .compacted(c)
    ?.map((m) => (m.content[0] as { text: string }).text)
  expect(texts).toEqual(["q1", "r1", "q2"])

  // A checkpoint that lacks its host (or is not one) is dropped, the summary kept.
  const t = SessionStore.create({ cwd: "/proj", dir: await tmp() })
  const a = t.appendMessage(userMessage("a"))
  const { host: _, ...noHost } = checkpoint
  t.append({ type: "compaction", summary: "S", replaces: [a], checkpoint: noHost, retained: "junk" as never })
  const damaged = SessionStore.open(t.file).restore().messages
  expect(damaged).toHaveLength(2)
  expect((damaged[0]!.content[0] as { signature?: unknown }).signature).toBeUndefined()
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

test("a compaction's reason, sizes and model restore with its summary; old entries have none", async () => {
  const dir = await tmp()
  const s = SessionStore.create({ cwd: "/proj", dir })
  const a = s.appendMessage(userMessage("a"))
  // Written before compactions kept why they happened.
  const c1 = s.append({ type: "compaction", summary: "S1", replaces: [a] })
  const old = s.restore()
  expect(old.compactions.size).toBe(0)
  s.appendMessage(userMessage("b"))
  s.append({
    type: "compaction",
    summary: "S2",
    replaces: [c1],
    reason: "threshold",
    tokensBefore: 105_000,
    tokensAfter: 12_000,
    contextWindow: 128_000,
    model: { provider: "p", model: "m" },
  })
  const { messages, compactions } = SessionStore.open(s.file).restore()
  expect(compactions.get(messages[0]!)).toEqual({
    reason: "threshold",
    tokensBefore: 105_000,
    tokensAfter: 12_000,
    contextWindow: 128_000,
    model: { provider: "p", model: "m" },
  })
  // Only the user message of the pair carries it.
  expect(compactions.get(messages[1]!)).toBeUndefined()
})

test("a compaction entry with a broken reason or sizes still restores", async () => {
  const dir = await tmp()
  const s = SessionStore.create({ cwd: "/proj", dir })
  const a = s.appendMessage(userMessage("a"))
  appendFileSync(
    s.file,
    `${JSON.stringify({ type: "compaction", id: "e_c", parentId: s.entries.at(-1)!.id, ts: 0, summary: "S", replaces: [a], reason: "why not", tokensBefore: "lots" })}\n`,
  )
  appendFileSync(
    s.file,
    `${JSON.stringify({ type: "compaction", id: "e_d", parentId: "e_c", ts: 0, summary: "T", replaces: ["e_c"], reason: "manual", tokensBefore: -1, model: "m" })}\n`,
  )
  const { messages, compactions } = SessionStore.open(s.file).restore()
  expect((messages[0]!.content[0] as { text: string }).text).toContain("T")
  expect(compactions.get(messages[0]!)).toEqual({ reason: "manual" })
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
  // Listing again reuses unchanged files and reads a file that grew.
  a.appendMessage(userMessage("more"))
  expect(listSessions("/proj", dir).find((s) => s.id === a.id)?.messageCount).toBe(3)
  expect(listSessions("/proj", dir).find((s) => s.id === b.id)?.messageCount).toBe(1)
})

test("session directories are per working directory", () => {
  expect(sessionsDir("/a")).not.toBe(sessionsDir("/b"))
  expect(sessionsDir("/a")).toBe(sessionsDir("/a/"))
})
