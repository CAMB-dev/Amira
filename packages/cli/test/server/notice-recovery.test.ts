import "./offline.ts"
import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import {
  type NoticeInputSnapshot,
  noticeInputSnapshot,
  subscribeNoticeInput,
} from "../../../core/src/agent/notice-input.ts"
import { frontendJson } from "../../../core/src/frontend/json.ts"
import type { RemoteWorkspaceSnapshot } from "../../src/remote-schema.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import * as sessionFactory from "../../src/session-factory.ts"

async function fixture(holdModel = false) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-notice-recovery-"))
  const modelGate = Promise.withResolvers<void>()
  let modelHeld = false
  const mock = createMockDialect([
    {
      text: "handled",
      ...(holdModel
        ? {
            hold: {
              chunks: 0,
              get until() {
                modelHeld = true
                return modelGate.promise
              },
            },
          }
        : {}),
    },
  ])
  // Observe construction only: the real workspace runtime still owns its session/capture.
  // This avoids adding a production API for manipulating notices and session holds in tests.
  let session!: sessionFactory.Session
  const create = sessionFactory.createSession
  const construction = spyOn(sessionFactory, "createSession").mockImplementation(async (options) => {
    session = await create(options)
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

function notice(text: string) {
  return userMessage(text, { origin: "subagent", text: "Background result" })
}

test("notice directly promoted after a real session hold is absent from queued recovery activity", async () => {
  const f = await fixture()
  const gate = Promise.withResolvers<void>()
  const hold = f.session.agent.hold("compaction", () => gate.promise)
  try {
    f.session.agent.expectNotice().deliver(notice("result delivered while held"))
    expect(f.session.agent.waitingNotices).toBe(1)
    expect(f.snapshot().owners[f.session.agent.sessionId]!.noticeInbox.queue).toHaveLength(1)
    expect(f.snapshot().activity.events.filter((event) => event.type === "turn.steer")).toHaveLength(0)
    gate.resolve()
    await hold
    await f.session.agent.currentTurn
    expect(f.mock.requests).toHaveLength(1)
    expect(f.session.agent.waitingNotices).toBe(0)
    const snapshot = f.snapshot()
    expect(snapshot.frontend.state.status).toBe("idle")
    expect(JSON.stringify(snapshot.frontend.transcript)).toContain("result delivered while held")
    expect(snapshot.activity.events.filter((event) => event.type === "turn.steer")).toEqual([])
  } finally {
    gate.resolve()
    await hold
    await f.close()
  }
})

test("batched 2x9 MiB notice injection followed by abort recovers after the authoritative inbox drains", async () => {
  const f = await fixture(true)
  const notices = [notice("a".repeat(9 * 1024 * 1024)), notice("b".repeat(9 * 1024 * 1024))]
  const pending = notices.map(() => f.session.agent.expectNotice())
  let injected = false
  const off = f.session.agent.bus.capture(
    (event) => {
      if (event.type === "turn.start") {
        pending.forEach((handle, i) => {
          handle.deliver(notices[i]!)
        })
      }
      if (event.type === "turn.steer" && event.data.state === "injected") injected = true
    },
    () => {},
  )
  try {
    const turn = f.session.agent.prompt("consume the queued results")
    await eventually(f.modelHeld)
    expect(injected).toBe(true)
    expect(f.session.agent.waitingNotices).toBe(0)
    f.session.agent.abort()
    f.modelGate.resolve()
    expect((await turn).reason).toBe("aborted")
    const snapshot = f.snapshot()
    expect(snapshot.frontend.state.status).toBe("idle")
    expect(snapshot.activity.events.filter((event) => event.type === "turn.steer")).toEqual([])
  } finally {
    off()
    await f.close()
  }
}, 30_000)

test("notice seam captures handover, cancellation, duplicate admissions, and drain synchronously", async () => {
  const first = await fixture()
  const second = await fixture()
  const source = first.session.agent
  const target = second.session.agent
  const changes: NoticeInputSnapshot[] = []
  const off = subscribeNoticeInput(target, (snapshot) => {
    expect(noticeInputSnapshot(target)).toEqual(snapshot)
    changes.push(snapshot)
  })
  try {
    const retained = notice("delivered notices stay with the original session")
    source.expectNotice().deliver(retained, { wake: false })
    const delivered = source.expectNotice()
    const cancelled = source.expectNotice()
    source.handoverBackgroundNotices(target)
    expect(noticeInputSnapshot(source)).toMatchObject({ queue: [{ message: retained }], expected: 0 })
    expect(noticeInputSnapshot(target)).toEqual({ queue: [], expected: 2 })
    cancelled.cancel()
    cancelled.deliver(notice("cancelled delivery must not enter either inbox"))
    expect(noticeInputSnapshot(target)).toEqual({ queue: [], expected: 1 })
    const message = notice("duplicate")
    delivered.deliver(message, { wake: false })
    target.expectNotice().deliver(message, { wake: false })
    const admitted = noticeInputSnapshot(target)
    expect(admitted.expected).toBe(0)
    expect(admitted.queue).toHaveLength(2)
    expect(new Set(admitted.queue.map((entry) => entry.id)).size).toBe(2)
    expect(admitted.queue[0]!.message).not.toBe(message)
    expect(Object.isFrozen(admitted.queue)).toBe(true)
    expect(Object.isFrozen(admitted.queue[0]!.message.content)).toBe(true)
    expect(changes.map((snapshot) => [snapshot.queue.length, snapshot.expected])).toEqual([
      [0, 2],
      [0, 1],
      [0, 0],
      [1, 0],
      [1, 1],
      [1, 0],
      [2, 0],
    ])
    expect(target.takeNotices()).toEqual([message, message])
    expect(noticeInputSnapshot(target)).toEqual({ queue: [], expected: 0 })
    expect(admitted.queue).toHaveLength(2)
    expect(source.waitingNotices).toBe(1)
  } finally {
    off()
    await first.close()
    await second.close()
  }
})

test("notice observer failures cannot reject an admitted notice and observers can unsubscribe", async () => {
  const f = await fixture()
  const failure = new Error("capture failed")
  const errors: unknown[] = []
  const changes: number[] = []
  const offFailure = subscribeNoticeInput(
    f.session.agent,
    () => {
      throw failure
    },
    (error) => errors.push(error),
  )
  const off = subscribeNoticeInput(f.session.agent, (snapshot) => changes.push(snapshot.queue.length))
  try {
    const pending = f.session.agent.expectNotice()
    expect(() => pending.deliver(notice("accepted despite capture failure"), { wake: false })).not.toThrow()
    expect(f.session.agent.waitingNotices).toBe(1)
    expect(errors).toEqual([failure, failure, failure])
    expect(changes).toEqual([0, 0, 1])
    off()
    offFailure()
    f.session.agent.takeNotices()
    expect(changes).toEqual([0, 0, 1])
  } finally {
    off()
    offFailure()
    await f.close()
  }
})

test("aborting a hold preserves genuinely unconsumed notices for later recovery and consumption", async () => {
  const f = await fixture()
  const gate = Promise.withResolvers<void>()
  const hold = f.session.agent.hold("compaction", () => gate.promise)
  const message = notice("not consumed by the aborted hold")
  try {
    f.session.agent.expectNotice().deliver(message)
    const admitted = noticeInputSnapshot(f.session.agent)
    f.session.agent.abort()
    gate.resolve()
    await hold
    expect(f.session.agent.waitingNotices).toBe(1)
    expect(noticeInputSnapshot(f.session.agent)).toEqual(admitted)
    expect(f.mock.requests).toHaveLength(0)
    expect(frontendJson(f.snapshot().owners[f.session.agent.sessionId]!.noticeInbox)).toEqual(
      frontendJson(admitted),
    )
    expect(f.snapshot().activity.events.filter((event) => event.type === "turn.steer")).toEqual([])
    await f.session.agent.prompt("consume it now")
    expect(f.session.agent.waitingNotices).toBe(0)
    expect(f.snapshot().activity.events.filter((event) => event.type === "turn.steer")).toEqual([])
  } finally {
    gate.resolve()
    await hold
    await f.close()
  }
})
