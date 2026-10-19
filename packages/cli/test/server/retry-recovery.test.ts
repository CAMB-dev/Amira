import "./offline.ts"
import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import type { RemoteWorkspaceSnapshot } from "../../src/remote-schema.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import * as sessionFactory from "../../src/session-factory.ts"

async function fixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-retry-recovery-"))
  const mock = createMockDialect([{ error: { message: "provider down" } }, { text: "handled" }])
  let session!: sessionFactory.Session
  const create = sessionFactory.createSession
  const construction = spyOn(sessionFactory, "createSession").mockImplementation(async (options) => {
    session = await create(options)
    return session
  })
  const runtime = await createWorkspaceRuntime({
    cwd,
    ai: createAi({
      dialects: [mock],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      retry: { retries: 0 },
    }),
    model: "mock/test",
    autoTitle: false,
    noticeRetryMs: [10_000],
    builtins: async () => [],
  }).finally(() => construction.mockRestore())
  const reset = () => {
    const replay = runtime.journal.open(
      undefined,
      () => runtime.workspaceSnapshot(),
      () => {},
    )
    try {
      const frame = replay.initial[0]!
      expect(frame.kind).toBe("reset")
      if (frame.kind !== "reset") throw new Error("Expected authoritative reset")
      return frame.snapshot as unknown as RemoteWorkspaceSnapshot
    } finally {
      replay.close()
    }
  }
  return {
    session,
    mock,
    runtime,
    reset,
    replay() {
      const replay = runtime.journal.open(
        { daemonEpoch: runtime.journal.daemonEpoch, after: 0 },
        () => runtime.workspaceSnapshot(),
        () => {},
      )
      replay.close()
      return replay.initial
    },
    async failNotice() {
      session.agent
        .expectNotice()
        .deliver(userMessage("background result", { origin: "subagent", text: "Background result" }))
      expect((await session.agent.currentTurn)?.reason).toBe("error")
      expect(session.agent.noticeRetry).toMatchObject({ attempt: 1 })
    },
    async close() {
      await runtime.stop()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}

test("an active notice retry keeps its authoritative schedule in reset and original error metadata in replay", async () => {
  const f = await fixture()
  try {
    await f.failNotice()
    const noticeRetry = f.session.agent.noticeRetry!
    const snapshot = f.reset()
    expect(snapshot).toMatchObject({ owners: { [f.session.agent.sessionId]: { noticeRetry } } })
    expect(snapshot.activity.events.filter((event) => event.type === "notice.retry")).toEqual([])
    expect(f.replay()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          payload: {
            kind: "noticeRetry",
            sessionId: f.session.agent.sessionId,
            sessionGeneration: snapshot.frontend.sessionGeneration,
            noticeRetry,
          },
        }),
        expect.objectContaining({
          kind: "event",
          payload: expect.objectContaining({
            type: "notice.retry",
            sessionId: f.session.agent.sessionId,
            data: { attempt: 1, attempts: 1, delayMs: 10_000, error: "provider down" },
          }),
        }),
      ]),
    )
    f.session.agent.cancelNoticeRetry()
    expect(snapshot).toMatchObject({ owners: { [f.session.agent.sessionId]: { noticeRetry } } })
    expect(f.reset()).toMatchObject({ owners: { [f.session.agent.sessionId]: { noticeRetry: null } } })
  } finally {
    await f.close()
  }
})

test("a successful follow-up removes cancelled notice retries from authoritative reset activity", async () => {
  const f = await fixture()
  try {
    await f.failNotice()
    expect((await f.session.agent.prompt("continue successfully")).reason).toBe("done")
    expect(f.session.agent.busy).toBe(false)
    expect(f.session.agent.waitingNotices).toBe(0)
    expect(f.session.agent.noticeRetry).toBeUndefined()
    const snapshot = f.reset()
    expect(snapshot).toMatchObject({ owners: { [f.session.agent.sessionId]: { noticeRetry: null } } })
    expect(f.replay()).toContainEqual(
      expect.objectContaining({
        kind: "event",
        payload: {
          kind: "noticeRetry",
          sessionId: f.session.agent.sessionId,
          sessionGeneration: snapshot.frontend.sessionGeneration,
          noticeRetry: null,
        },
      }),
    )
    expect(snapshot.frontend.state.status).toBe("idle")
    expect(snapshot.activity.events.filter((event) => event.type === "notice.retry")).toEqual([])
    expect(snapshot.activity.events.filter((event) => event.type === "turn.start")).toEqual([])
    expect(f.mock.requests).toHaveLength(2)
  } finally {
    await f.close()
  }
})

test("explicit cancelNoticeRetry removes a failed notice retry from authoritative reset activity", async () => {
  const f = await fixture()
  try {
    await f.failNotice()
    f.session.agent.cancelNoticeRetry()
    expect(f.session.agent.noticeRetry).toBeUndefined()
    const snapshot = f.reset()
    expect(snapshot).toMatchObject({ owners: { [f.session.agent.sessionId]: { noticeRetry: null } } })
    expect(f.replay()).toContainEqual(
      expect.objectContaining({
        kind: "event",
        payload: {
          kind: "noticeRetry",
          sessionId: f.session.agent.sessionId,
          sessionGeneration: snapshot.frontend.sessionGeneration,
          noticeRetry: null,
        },
      }),
    )
    expect(snapshot.frontend.state.status).toBe("idle")
    expect(snapshot.activity.events.filter((event) => event.type === "notice.retry")).toEqual([])
    expect(f.mock.requests).toHaveLength(1)
  } finally {
    await f.close()
  }
})
