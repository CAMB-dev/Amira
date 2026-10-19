import "./offline.ts"
import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import { noticeInputAgents, noticeInputSnapshot } from "../../../core/src/agent/notice-input.ts"
import { encodeRemoteMessage, RemoteDecoder } from "../../src/remote/codec.ts"
import { type RemoteWorkspaceSnapshot, validateRemoteDto } from "../../src/remote-schema.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import * as sessionFactory from "../../src/session-factory.ts"

async function eventually(check: () => boolean) {
  const end = Date.now() + 3000
  while (!check() && Date.now() < end) await Bun.sleep(1)
  expect(check()).toBe(true)
}

async function fixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-reset-authority-"))
  const gate = Promise.withResolvers<void>()
  let held = false
  const mock = createMockDialect([
    {
      text: "first",
      hold: {
        chunks: 0,
        get until() {
          held = true
          return gate.promise
        },
      },
    },
    { text: "second" },
  ])
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
    runtime,
    session,
    gate,
    mock,
    held: () => held,
    async close() {
      gate.resolve()
      await runtime.stop()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}

test("a fresh wire reset retains an accepted queued child's message, admission id and expected count", async () => {
  const f = await fixture()
  try {
    const group = f.session.tree.createGroup(f.session.agent, { name: "one slot", maxConcurrent: 1 })
    const first = group.spawn({ prompt: "occupy slot" })
    await eventually(f.held)
    const second = group.spawn({ prompt: "queued work", persistent: true })
    expect(second.state).toBe("queued")
    const before = f.runtime.journal.watermark
    const message = userMessage("UNIQUE_FOLLOWUP")
    expect(second.send(message)).toBe(true)
    const pending = second.expectNotice()
    const owner = noticeInputAgents(f.session.agent.bus).find((agent) => agent.sessionId === second.id)!
    const authoritative = noticeInputSnapshot(owner)
    const admission = authoritative.queue.find(
      (entry) => JSON.stringify(entry.message) === JSON.stringify(message),
    )!
    expect(admission).toBeDefined()
    const reset = f.runtime.journal.open(
      undefined,
      () => f.runtime.workspaceSnapshot(),
      () => {},
    )
    try {
      const frame = reset.initial[0]!
      expect(JSON.stringify(frame)).toContain("UNIQUE_FOLLOWUP")
      expect(JSON.stringify(frame)).toContain(admission.id)
      if (frame.kind !== "reset") throw new Error("Expected reset")
      validateRemoteDto("workspaceSnapshot", frame.snapshot)
      const decoder = new RemoteDecoder()
      const decoded = [...encodeRemoteMessage(frame)].flatMap((bytes) => decoder.push(bytes))
      decoder.finish()
      expect(decoded).toHaveLength(1)
      const snapshot = frame.snapshot as unknown as RemoteWorkspaceSnapshot
      expect<unknown>(snapshot.owners[second.id]!.noticeInbox).toEqual(authoritative)
      const replay = f.runtime.journal.open(
        { daemonEpoch: f.runtime.journal.daemonEpoch, after: before },
        () => f.runtime.workspaceSnapshot(),
        () => {},
      )
      try {
        expect(JSON.stringify(replay.initial)).toContain(admission.id)
      } finally {
        replay.close()
      }
      pending.cancel()
      f.gate.resolve()
      await first.result()
      await eventually(() => f.mock.requests.length === 2 && second.state === "idle")
      expect(
        (f.runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot).owners[second.id]!.noticeInbox,
      ).toEqual({ queue: [], expected: 0 })
    } finally {
      reset.close()
    }
  } finally {
    await f.close()
  }
}, 15_000)

test("private-bus owners and their accepted inbox messages never enter a workspace reset", async () => {
  const f = await fixture()
  try {
    const child = f.session.tree.spawn(f.session.agent, { prompt: "private work", ephemeral: true })
    await eventually(f.held)
    expect(child.send("PRIVATE_INBOX_SENTINEL")).toBe(true)
    const reset = f.runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot
    expect(JSON.stringify(reset)).not.toContain("PRIVATE_INBOX_SENTINEL")
    expect(reset.owners[child.id]).toBeUndefined()
    f.gate.resolve()
  } finally {
    await f.close()
  }
}, 15_000)

test("reset and notice consumption use the same owned admission when the caller mutates its message", async () => {
  const f = await fixture()
  try {
    const message = userMessage("before")
    f.session.agent.expectNotice().deliver(message, { wake: false })
    const block = message.content[0]!
    if (block.type !== "text") throw new Error("Expected text")
    block.text = "after"
    const reset = f.runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot
    const queued = reset.owners[f.session.agent.sessionId]!.noticeInbox.queue[0]!
    const consumed = f.session.agent.takeNotices()[0]!
    expect(JSON.stringify(queued.message)).toBe(JSON.stringify(consumed))
    expect(queued.id).toBeDefined()
  } finally {
    await f.close()
  }
})

test("reset and held steering execute the same owned message after caller mutation", async () => {
  const f = await fixture()
  const holdGate = Promise.withResolvers<void>()
  const hold = f.session.agent.hold("owned input", () => holdGate.promise)
  try {
    const message = userMessage("before")
    f.session.agent.steer(message)
    const block = message.content[0]!
    if (block.type !== "text") throw new Error("Expected text")
    block.text = "after"
    const reset = f.runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot
    const queued = reset.owners[f.session.agent.sessionId]!.inputQueue[0]!
    holdGate.resolve()
    await hold
    f.gate.resolve()
    await f.session.agent.currentTurn
    const consumed = f.mock.requests[0]!.messages.findLast((entry) => entry.role === "user")!
    expect(JSON.stringify(queued.message)).toBe(JSON.stringify(consumed))
  } finally {
    holdGate.resolve()
    await hold
    await f.close()
  }
}, 15_000)
