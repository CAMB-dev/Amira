import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import { Agent, type AgentOptions } from "../src/agent.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-agent-constructor-"))
  const store = SessionStore.create({ cwd: dir, dir })
  store.appendMessage(userMessage("valid history"))
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const options: AgentOptions = { ai, model: ai.model("mock/m"), cwd: dir, session: store }
  return { dir, store, options }
}

test("failed history restoration releases its constructor claim before the file is repaired", () => {
  const { dir, store, options } = fixture()
  const valid = readFileSync(store.file, "utf8")
  const bad = { type: "message", id: "bad", parent: store.entries.at(-1)!.id, message: null }
  writeFileSync(store.file, `${valid}${JSON.stringify(bad)}\n`)
  const malformed = SessionStore.open(store.file)
  let repaired: SessionStore | undefined
  try {
    expect(() => new Agent({ ...options, session: malformed })).toThrow(TypeError)
    expect(existsSync(sessionLockFile(store.file))).toBe(false)

    writeFileSync(store.file, valid)
    repaired = SessionStore.open(store.file)
    expect(repaired.claim()).toBe(true)
    store.appendDisplay({ type: "display", text: "one repaired owner", level: "info" })
    expect(SessionStore.open(store.file).restore().messages).toEqual([userMessage("valid history")])
    repaired.release()
    expect(existsSync(sessionLockFile(store.file))).toBe(false)
  } finally {
    repaired?.release()
    malformed.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test.each(["before history", "after history"])(
  "an initialization throw %s releases the acquired claim",
  (stage) => {
    const { dir, store, options } = fixture()
    const failure = new Error(`initialization failed ${stage}`)
    const throwing: AgentOptions = {
      ...options,
      get fileRewindSettings() {
        if (stage === "before history") throw failure
        return undefined
      },
      get originals() {
        if (stage === "after history") throw failure
        return undefined
      },
    }
    try {
      expect(() => new Agent(throwing)).toThrow(failure)
      expect(existsSync(sessionLockFile(store.file))).toBe(false)
      expect(store.claim()).toBe(true)
      store.release()
      expect(existsSync(sessionLockFile(store.file))).toBe(false)
    } finally {
      store.release()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test.each(["same store", "another store", "unclaimed child"])(
  "a failed constructor using the %s preserves the live owner's claim",
  async (view) => {
    const { dir, store, options } = fixture()
    const owner = new Agent(options)
    const failed = view === "another store" ? SessionStore.open(store.file) : store
    const observer = SessionStore.open(store.file)
    const failure = new Error("initialization failed")
    try {
      expect(
        () =>
          new Agent({
            ...options,
            session: failed,
            ...(view === "unclaimed child" ? { depth: 1, parentSessionId: owner.sessionId } : {}),
            get fileRewindSettings(): AgentOptions["fileRewindSettings"] {
              throw failure
            },
          }),
      ).toThrow(failure)
      expect(existsSync(sessionLockFile(store.file))).toBe(true)
      observer.appendDisplay({ type: "display", text: "still one live owner", level: "info" })
      expect(SessionStore.open(store.file).entries.at(-1)).toMatchObject({
        type: "display",
        text: "still one live owner",
      })
      await owner.dispose("switch")
      expect(existsSync(sessionLockFile(store.file))).toBe(false)
    } finally {
      await owner.dispose("switch")
      failed.release()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
