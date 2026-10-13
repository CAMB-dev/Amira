import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { tryFileLock } from "../src/file-lock.ts"
import { SessionConflictError, SessionStore, sessionLockFile } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"

for (const end of ["done", "switch", "exit"] as const) {
  test(`persisted child holds one lazy lease until ${end}, then late writes leave no lease`, async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "amira-child-lease-"))
    const opened = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const ai = createAi({
      dialects: [
        createMockDialect([
          () => {
            opened.resolve()
            return end === "done"
              ? { text: "child", hold: { chunks: 0, until: release.promise } }
              : { text: "child", delayMs: 10_000 }
          },
        ]),
      ],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    })
    const tree = new AgentTree({ ai, sections: () => [], maxConcurrent: 1 })
    const parent = new Agent({
      ai,
      tree,
      model: ai.model("mock/m"),
      cwd: dir,
      session: SessionStore.create({ cwd: dir, dir }),
      sections: [],
    })
    let restoreLink: (() => void) | undefined
    try {
      const child = tree.spawn(parent, { prompt: "work" })
      const store = tree.subagent(child.id)!.session!
      const file = sessionLockFile(store.file)
      expect(fs.existsSync(file)).toBe(false)
      expect(fs.existsSync(store.file)).toBe(false)
      const link = spyOn(fs, "linkSync")
      restoreLink = () => link.mockRestore()
      await opened.promise
      expect(fs.existsSync(file)).toBe(true)
      for (let i = 0; i < 10; i++) store.appendMessage(userMessage(`entry ${i}`))
      expect(link.mock.calls.filter(([, target]) => target === file)).toHaveLength(1)
      link.mockRestore()
      restoreLink = undefined
      expect(tryFileLock(file, 60_000, undefined, true)).toBeUndefined()
      if (end === "done") release.resolve()
      else await parent.dispose(end)
      expect((await child.result()).status).toBe(end === "done" ? "done" : "aborted")
      await tree.waitForChildren()
      expect(fs.readdirSync(path.dirname(store.file))).toEqual([path.basename(store.file)])
      store.appendDisplay({ type: "display", text: "late print", level: "info" })
      expect(fs.readdirSync(path.dirname(store.file))).toEqual([path.basename(store.file)])
      const resumed = SessionStore.open(store.file)
      resumed.claim()
      try {
        store.appendDisplay({ type: "display", text: "retained print", level: "info" })
        expect(resumed.entries.at(-1)).toMatchObject({ type: "display", text: "retained print" })
      } finally {
        resumed.release()
      }
    } finally {
      restoreLink?.()
      release.resolve()
      await parent.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("a child constructor failing after its first write drops its lazy lease and scope", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "amira-child-constructor-lease-"))
  const store = SessionStore.create({ cwd: dir, dir })
  store.appendMessage(userMessage("stored"))
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const failure = new Error("failed after model_change")
  let reads = 0
  try {
    expect(
      () =>
        new Agent({
          ai,
          model: ai.model("mock/m"),
          cwd: dir,
          session: store,
          depth: 1,
          parentSessionId: "parent",
          sections: [],
          get tree() {
            if (++reads === 2) throw failure
            return undefined
          },
        }),
    ).toThrow(failure)
    expect(store.entries.at(-1)).toMatchObject({ type: "model_change" })
    expect(fs.readdirSync(dir)).toEqual([path.basename(store.file)])
    store.appendMessage(userMessage("ownerless after failure"))
    expect(fs.readdirSync(dir)).toEqual([path.basename(store.file)])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("lazy write scopes release exact refs, including cancellation before any write", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "amira-lazy-write-lease-"))
  const store = SessionStore.create({ cwd: dir, dir: path.join(dir, "sessions") })
  const cancelled = store.claimOnWrite()
  cancelled()
  const first = store.claimOnWrite()
  const second = store.claimOnWrite()
  try {
    store.append({ type: "custom", ext: "buffered", data: "no artifacts" })
    expect(fs.existsSync(path.dirname(store.file))).toBe(false)
    store.appendMessage(userMessage("first durable write"))
    expect(fs.existsSync(sessionLockFile(store.file))).toBe(true)
    first()
    first()
    expect(fs.existsSync(sessionLockFile(store.file))).toBe(true)
    second()
    expect(fs.readdirSync(path.dirname(store.file))).toEqual([path.basename(store.file)])
    store.appendDisplay({ type: "display", text: "late", level: "info" })
    expect(fs.readdirSync(path.dirname(store.file))).toEqual([path.basename(store.file)])
  } finally {
    first()
    second()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("first lazy claim validates without merging a stale child's live context", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "amira-stale-child-lease-"))
  const origin = SessionStore.create({ cwd: dir, dir })
  origin.appendMessage(userMessage("old"))
  const stale = SessionStore.open(origin.file)
  const release = stale.claimOnWrite()
  try {
    origin.appendMessage(userMessage("new"))
    expect(() => stale.appendMessage(userMessage("must not merge"))).toThrow(SessionConflictError)
    expect(stale.restore().messages).toEqual([userMessage("old")])
    expect(fs.existsSync(sessionLockFile(origin.file))).toBe(false)
  } finally {
    release()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
