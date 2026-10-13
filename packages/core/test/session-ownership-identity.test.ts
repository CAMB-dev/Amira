import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, emptyUsage, userMessage } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { SessionConflictError, SessionStore } from "../src/session-store.ts"

test("reclaiming an owned stale view cannot silently replace a live Agent's persistence snapshot", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-owned-reclaim-"))
  const mock = createMockDialect([{ text: "B answer" }, { text: "A answer" }])
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const store = SessionStore.create({ cwd: dir, dir })
  store.appendDisplay({ type: "display", text: "stored", level: "info" })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const a = new Agent({ ai, bus, model: ai.model("mock/m"), cwd: dir, session: store, sections: [] })
  const b = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: dir,
    session: SessionStore.open(store.file),
    sections: [],
  })
  let c: Agent | undefined
  try {
    await b.prompt("B question")
    const before = JSON.stringify(store.entries)
    expect(() => {
      c = new Agent({ ai, model: ai.model("mock/m"), cwd: dir, session: store, sections: [] })
    }).toThrow(SessionConflictError)
    expect(JSON.stringify(store.entries)).toBe(before)
    expect(a.messages).toEqual([])
    await a.prompt("A question")
    await bus.flush()
    expect(
      events.filter((event) => event.type === "extension.error" && event.data.source === "session"),
    ).toHaveLength(1)
    expect(SessionStore.open(store.file).restore().messages).toEqual(b.messages)
  } finally {
    await c?.dispose()
    await a.dispose()
    await b.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("retained metadata cannot cross a same-ID replacement incarnation with a live owner", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-session-incarnation-"))
  const original = SessionStore.create({ cwd: dir, dir })
  original.appendMessage(userMessage("old incarnation"))
  original.claim()
  original.release()
  rmSync(original.file)
  const replacement = SessionStore.create({ cwd: path.join(dir, "new-project"), dir, id: original.id })
  replacement.appendMessage(userMessage("new incarnation"))
  replacement.claim()
  try {
    expect(() =>
      original.append({
        type: "side_usage",
        model: { provider: "mock", model: "m" },
        usage: { ...emptyUsage(), cost: 3 },
      }),
    ).toThrow("different session")
    expect(() => original.appendDisplay({ type: "display", text: "old answer", level: "info" })).toThrow(
      "different session",
    )
    replacement.appendMessage(userMessage("new owner still saves"))
    expect(SessionStore.open(replacement.file).entries).toEqual(replacement.entries)
    expect(
      replacement.entries.filter((entry) => entry.type === "side_usage" || entry.type === "display"),
    ).toEqual([])
  } finally {
    replacement.release()
    rmSync(dir, { recursive: true, force: true })
  }
})
