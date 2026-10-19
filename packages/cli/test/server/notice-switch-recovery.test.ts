import "./offline.ts"
import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import type { RemoteWorkspaceSnapshot } from "../../src/remote-schema.ts"
import type { JournalEvent } from "../../src/server/journal.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import * as sessionFactory from "../../src/session-factory.ts"

async function fixture(holdModel = false, beforeCapture?: (session: sessionFactory.Session) => void) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-notice-switch-"))
  const modelGate = Promise.withResolvers<void>()
  let modelHeld = false
  const mock = createMockDialect([
    {
      text: "new partial continues",
      ...(holdModel
        ? {
            hold: {
              chunks: 1,
              get until() {
                modelHeld = true
                return modelGate.promise
              },
            },
          }
        : {}),
    },
    { text: "follow-up handled" },
  ])
  let session!: sessionFactory.Session
  const create = sessionFactory.createSession
  const construction = spyOn(sessionFactory, "createSession").mockImplementation(async (options) => {
    session = await create(options)
    beforeCapture?.(session)
    return session
  })
  const runtime = await createWorkspaceRuntime({
    cwd,
    ai: createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] }),
    model: "mock/test",
    autoTitle: false,
    builtins: async () => [],
  }).finally(() => construction.mockRestore())
  return {
    session,
    mock,
    runtime,
    modelGate,
    modelHeld: () => modelHeld,
    snapshot: () => runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot,
    async close() {
      modelGate.resolve()
      await runtime.stop()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}

async function eventually(check: () => boolean) {
  const end = Date.now() + 3000
  while (!check() && Date.now() < end) await Bun.sleep(1)
  expect(check()).toBe(true)
}

test("capture bootstraps an inbox that was active before runtime subscriptions", async () => {
  const message = userMessage("queued before host capture")
  const f = await fixture(false, (session) => {
    session.agent.expectNotice().deliver(message, { wake: false })
  })
  try {
    const cut = f.runtime.journal.open(
      { daemonEpoch: f.runtime.journal.daemonEpoch, after: 0 },
      () => f.runtime.workspaceSnapshot(),
      () => {},
    )
    try {
      expect(cut.initial).toContainEqual(
        expect.objectContaining({
          kind: "event",
          payload: {
            kind: "noticeInbox",
            noticeInbox: { queue: [expect.objectContaining({ message })], expected: 0 },
            sessionId: f.session.agent.sessionId,
            sessionGeneration: 1,
          },
        }),
      )
    } finally {
      cut.close()
    }
    expect(f.snapshot().owners[f.session.agent.sessionId]!.noticeInbox.queue).toHaveLength(1)
    f.session.agent.takeNotices()
    expect(f.snapshot().owners[f.session.agent.sessionId]!.noticeInbox).toEqual({ queue: [], expected: 0 })
  } finally {
    await f.close()
  }
})

test("persistent child follow-up drains its queued notice without switching the root session", async () => {
  const f = await fixture()
  const events: JournalEvent[] = []
  const cut = f.runtime.journal.open(
    undefined,
    () => f.runtime.workspaceSnapshot(),
    (event) => events.push(event),
  )
  try {
    const before = f.snapshot().frontend
    const child = f.session.tree.spawn(f.session.agent, { prompt: "initial work", persistent: true })
    await eventually(() => f.session.tree.subagent(child.id)?.info.status === "idle")
    expect(f.session.tree.message(child.id, "follow-up message")).toBe(true)
    await eventually(
      () => f.mock.requests.length === 2 && f.session.tree.subagent(child.id)?.info.status === "idle",
    )
    const snapshot = f.snapshot()
    expect(snapshot.frontend.state.sessionId).toBe(before.state.sessionId)
    expect(snapshot.frontend.sessionGeneration).toBe(before.sessionGeneration)
    expect(snapshot.owners[snapshot.frontend.state.sessionId]!.noticeInbox).toEqual({
      queue: [],
      expected: 0,
    })
    expect(snapshot.activity.events.filter((event) => event.type === "turn.steer")).toEqual([])
    const inboxes = events.flatMap((event) => {
      const payload = event.payload
      return payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        payload.kind === "noticeInbox" &&
        payload.sessionId === child.id
        ? [payload]
        : []
    })
    expect(inboxes).toContainEqual(
      expect.objectContaining({
        noticeInbox: {
          queue: [expect.objectContaining({ message: userMessage("follow-up message") })],
          expected: 0,
        },
        sessionGeneration: before.sessionGeneration,
      }),
    )
    expect(inboxes.at(-1)).toMatchObject({ noticeInbox: { queue: [], expected: 0 } })
  } finally {
    cut.close()
    await f.close()
  }
})

test("clear preserves replacement partial already streaming during the old agent disposal wait", async () => {
  const f = await fixture(true)
  const old = f.session.agent
  const pending = old.expectNotice()
  const disposeGate = Promise.withResolvers<void>()
  let disposed = false
  const dispose = old.dispose.bind(old)
  const disposal = spyOn(old, "dispose").mockImplementation(async (reason) => {
    await dispose(reason)
    disposed = true
    await disposeGate.promise
  })
  const local = f.runtime.attach()
  let clearing: Promise<unknown> | undefined
  try {
    // Retired semantic and queued state must not survive alongside the replacement's work.
    old.expectNotice().deliver(userMessage("retired queued notice"), { wake: false })
    old.bus.emit("compact.start", { reason: "manual", replacing: 1, kept: 0 }, { sessionId: old.sessionId })
    clearing = local.execute("session.clear", {})
    await eventually(() => disposed)
    pending.deliver(userMessage("retained result", { origin: "subagent", text: "Background result" }))
    await eventually(f.modelHeld)
    expect(f.snapshot().activity.events.some((event) => event.type === "message.delta")).toBe(true)
    disposeGate.resolve()
    await clearing
    const cut = f.runtime.journal.open(
      undefined,
      () => f.runtime.workspaceSnapshot(),
      () => {},
    )
    try {
      const reset = cut.initial[0]!
      expect(reset.kind).toBe("reset")
      if (reset.kind !== "reset") throw new Error("Expected reset")
      const snapshot = reset.snapshot as unknown as RemoteWorkspaceSnapshot
      expect(snapshot.frontend.state.sessionId).not.toBe(old.sessionId)
      expect(snapshot.frontend.state.status).toBe("working")
      expect(snapshot.activity.events.filter((event) => event.type === "message.delta")).toEqual([
        expect.objectContaining({
          sessionId: snapshot.frontend.state.sessionId,
          data: { kind: "text", text: "new part" },
        }),
      ])
      expect(snapshot.activity.events.some((event) => event.sessionId === old.sessionId)).toBe(false)
      expect(snapshot.owners[snapshot.frontend.state.sessionId]!.noticeInbox).toEqual({
        queue: [],
        expected: 0,
      })
    } finally {
      cut.close()
    }
    let continued = false
    const off = old.bus.capture(
      (event) => {
        if (event.type !== "message.delta") return
        continued ||= f
          .snapshot()
          .activity.events.some(
            (partial) =>
              partial.type === "message.delta" &&
              partial.data.kind === "text" &&
              partial.data.text === "new partial cont",
          )
      },
      () => {},
    )
    try {
      f.modelGate.resolve()
      await eventually(() => continued)
      await eventually(() => f.snapshot().frontend.state.status === "idle")
      expect(JSON.stringify(f.snapshot().frontend.transcript)).toContain("new partial continues")
    } finally {
      off()
    }
  } finally {
    disposeGate.resolve()
    f.modelGate.resolve()
    await clearing
    disposal.mockRestore()
    await local.detach()
    await f.close()
  }
})
