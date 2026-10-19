import "./offline.ts"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { ExtensionAPI } from "@amira/api"
import { RemoteConnection } from "../../src/remote/connection.ts"
import type { RemoteHello, RemoteMessage, RemoteWelcome } from "../../src/remote/protocol.ts"
import { RemoteReplay } from "../../src/remote/replay.ts"
import { type RemoteWorkspaceSnapshot, validateRemoteDto } from "../../src/remote-schema.ts"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { hello, loopback } from "../remote/loopback.ts"

async function eventually(check: () => boolean) {
  const end = Date.now() + 4000
  while (!check() && Date.now() < end) await Bun.sleep(1)
  expect(check()).toBe(true)
}
async function fixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-replay-"))
  let api!: ExtensionAPI
  let invocations = 0
  const runtime = await createWorkspaceRuntime({
    cwd,
    model: "mock/test",
    autoTitle: false,
    ai: createAi({
      dialects: [createMockDialect([{ text: "finished detached", delayMs: 20 }])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    builtins: async () => [
      {
        source: "fixture",
        extension: (value) => {
          api = value
          api.registerCommand({
            name: "approval",
            description: "Fixture",
            run: async (_args, ctx) => {
              invocations++
              ctx.print((await api.ui.confirm("Keep approval alive")) ? "approved" : "declined")
            },
          })
        },
      },
    ],
  })
  const authority = workspaceAttachments(runtime, { graceMs: 100, heartbeatMs: 0 })
  const connections: RemoteConnection[] = []
  const connect = (resume?: RemoteHello["resume"], extra: Partial<RemoteHello> = {}, drop?: string) => {
    const io = loopback(37)
    const frames: RemoteMessage[] = []
    const server = authority.connect(
      {
        ...io.server,
        async write(bytes) {
          const text = new TextDecoder().decode(bytes)
          if (drop && text.includes('"kind":"response"') && text.includes(`"id":"${drop}"`)) return
          await io.server.write(bytes)
        },
      },
      { workspace: cwd, release: hello.release },
    )
    const client = new RemoteConnection(io.client, {
      handshake: {
        role: "client",
        hello: { ...hello, workspace: cwd, ...(resume ? { resume } : {}), ...extra },
      },
      onMessage: (frame) => frames.push(frame),
    })
    connections.push(client, server)
    return { client, server, frames }
  }
  return {
    runtime,
    connect,
    api: () => api,
    invocations: () => invocations,
    async close() {
      for (const connection of connections) connection.close()
      await Promise.all(connections.map((connection) => connection.closed))
      await runtime.stop()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}
const resume = (welcome: RemoteWelcome, after: number) => ({
  daemonEpoch: welcome.daemonEpoch,
  after,
  controllerToken: welcome.controllerToken!,
})
const snapshot = (frames: RemoteMessage[]) => {
  const frame = frames.find((frame) => frame.kind === "reset")
  if (frame?.kind !== "reset") throw new Error("Expected reset")
  return frame.snapshot as unknown as RemoteWorkspaceSnapshot
}

test("pending approvals and admitted commands survive EOF; reconnect retry runs once and fences the old controller", async () => {
  const f = await fixture()
  try {
    const first = f.connect()
    const welcome = await first.client.ready
    await eventually(() => first.frames.some((frame) => frame.kind === "reset"))
    const lost = first.client
      .request("command.run", { line: "/approval" }, { operationId: "command-1" })
      .catch((error) => error)
    await eventually(
      () =>
        (f.runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot).pendingRequests.length === 1,
    )
    const cut = f.runtime.journal.watermark
    const second = f.connect(resume(welcome, cut), { snapshot: true })
    const next = await second.client.ready
    await first.server.closed
    await lost
    await eventually(() => second.frames.some((frame) => frame.kind === "reset"))
    expect(next.controllerGeneration).toBeGreaterThan(welcome.controllerGeneration)
    expect(snapshot(second.frames).pendingRequests).toHaveLength(1)
    const id = snapshot(second.frames).pendingRequests[0]!.requestId
    await expect(
      second.client.request(
        "ui.respond",
        { requestId: id, value: true },
        { controllerGeneration: welcome.controllerGeneration },
      ),
    ).rejects.toMatchObject({ code: "stale_controller" })
    const retry = second.client.request("command.run", { line: "/approval" }, { operationId: "command-1" })
    expect(
      await second.client.request("ui.respond", { requestId: id, value: true }, { operationId: "answer-1" }),
    ).toEqual({ status: "accepted" })
    expect(await retry).toMatchObject({ ok: true, output: ["approved"] })
    expect(f.invocations()).toBe(1)
    const third = f.connect(resume(next, f.runtime.journal.watermark), { snapshot: true })
    await third.client.ready
    await eventually(() => third.frames.some((frame) => frame.kind === "reset"))
    expect(snapshot(third.frames).pendingRequests).toHaveLength(0)
    expect(
      await third.client.request("ui.respond", { requestId: id, value: true }, { operationId: "answer-1" }),
    ).toEqual({ status: "accepted" })
    expect(f.invocations()).toBe(1)
  } finally {
    await f.close()
  }
}, 15_000)

test("lost prompt reply, detached completion, replay and session-switch retries never repeat admission", async () => {
  const f = await fixture()
  try {
    const first = f.connect(undefined, {}, "prompt-1")
    const welcome = await first.client.ready
    const lost = first.client
      .request("turn.prompt", { message: "once" }, { operationId: "prompt-1" })
      .catch((error) => error)
    await eventually(() => JSON.stringify(f.runtime.workspaceSnapshot()).includes("finished detached"))
    const cursor = first.frames.filter((frame) => frame.kind === "event" || frame.kind === "reset").at(-1)!
    const after = "seq" in cursor ? cursor.seq : 0
    first.client.close()
    await lost
    await first.server.closed
    f.api().notify("while disconnected")
    const second = f.connect(resume(welcome, after))
    const next = await second.client.ready
    expect(
      await second.client.request("turn.prompt", { message: "once" }, { operationId: "prompt-1" }),
    ).toEqual({ sessionGeneration: 1 })
    await eventually(() => second.frames.some((frame) => frame.kind === "event"))
    const replayed = second.frames.filter((frame) => frame.kind === "event")
    expect(replayed.some((frame) => frame.kind === "event" && frame.replay)).toBe(true)
    const state = f.runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot
    expect(state.frontend.transcript.messages.filter((entry) => entry.message.role === "user")).toHaveLength(
      1,
    )
    expect(await second.client.request("session.clear", {}, { operationId: "switch-1" })).toEqual({
      sessionGeneration: 2,
    })
    const third = f.connect(resume(next, f.runtime.journal.watermark))
    await third.client.ready
    expect(
      await third.client.request("session.clear", {}, { operationId: "switch-1", sessionGeneration: 1 }),
    ).toEqual({ sessionGeneration: 2 })
    await expect(third.client.request("turn.abort", {}, { sessionGeneration: 1 })).rejects.toMatchObject({
      code: "stale_session",
    })
    await expect(
      third.client.request(
        "turn.prompt",
        { message: "different" },
        { operationId: "prompt-1", sessionGeneration: 1 },
      ),
    ).rejects.toMatchObject({ code: "operation_conflict" })
    await expect(
      third.client.request("turn.prompt", { message: "unknown" }, { daemonEpoch: "crashed-epoch" }),
    ).rejects.toMatchObject({ code: "outcome_unknown" })
  } finally {
    await f.close()
  }
}, 15_000)

test("second client is busy; reset snapshots include semantic state and cannot reopen same-stack settled requests", async () => {
  const f = await fixture()
  try {
    const first = f.connect()
    const welcome = await first.client.ready
    const other = f.connect(undefined, { clientId: "other" })
    await expect(other.client.ready).rejects.toMatchObject({ code: "controller_busy" })
    const answer = f.api().ui.confirm("Transient")
    const direct = f.runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot
    const requestId = direct.pendingRequests[0]!.requestId
    await first.client.request("ui.respond", { requestId, value: false })
    expect(await answer).toBe(false)
    const next = f.connect(resume(welcome, Number.MAX_SAFE_INTEGER))
    await next.client.ready
    await eventually(() => next.frames.some((frame) => frame.kind === "reset"))
    const state = snapshot(next.frames)
    expect(next.frames.find((frame) => frame.kind === "reset")).toMatchObject({ reason: "future_cursor" })
    validateRemoteDto("workspaceSnapshot", state)
    expect(state.pendingRequests).toEqual([])
    expect(state.semantic.status.info.model.model).toBe("test")
    expect(state.semantic.models[0]!.ref).toBe("mock/test")
    expect(state.semantic.subagents).toEqual([])
  } finally {
    await f.close()
  }
}, 15_000)

test("a retained backlog larger than the live queue streams after welcome without blocking reconnect", async () => {
  const f = await fixture()
  try {
    const first = f.connect()
    const welcome = await first.client.ready
    await Bun.sleep(0)
    const after = f.runtime.journal.watermark
    first.client.close()
    await first.server.closed
    for (let i = 0; i < 1500; i++)
      f.runtime.journal.append({
        seq: i + 1,
        ts: i,
        sessionId: "host",
        type: "ui.focus",
        data: { focused: false },
      })
    const second = f.connect(resume(welcome, after))
    await second.client.ready
    expect(await second.client.request("state.read", {})).toMatchObject({ status: "idle" })
    await eventually(() => second.frames.filter((frame) => frame.kind === "event").length === 1500)
    const events = second.frames.filter((frame) => frame.kind === "event")
    expect(events.every((frame) => frame.replay)).toBe(true)
    expect(events.map((frame) => frame.seq)).toEqual(Array.from({ length: 1500 }, (_, i) => after + i + 1))
  } finally {
    await f.close()
  }
}, 15_000)

test("an up-to-date reconnect can acknowledge its retained watermark before any new event", async () => {
  const f = await fixture()
  try {
    const first = f.connect()
    const welcome = await first.client.ready
    await Bun.sleep(0)
    const after = f.runtime.journal.watermark
    const second = f.connect(resume(welcome, after))
    await second.client.ready
    await second.client.send({ v: 1, kind: "ack", channel: "control", id: welcome.daemonEpoch, seq: after })
    expect(await second.client.request("state.read", {})).toMatchObject({ status: "idle" })
    expect(second.frames).toEqual([])
  } finally {
    await f.close()
  }
}, 15_000)

test("future-cursor recovery through the attachment codec adopts the server watermark before acknowledging", async () => {
  const f = await fixture()
  try {
    const first = f.connect()
    const welcome = await first.client.ready
    const cursor = f.runtime.journal.watermark + 100
    const next = f.connect(resume(welcome, cursor))
    await next.client.ready
    await eventually(() => next.frames.some((frame) => frame.kind === "reset"))
    const projection = new RemoteReplay(
      { reset: () => {}, event: () => {} },
      { daemonEpoch: welcome.daemonEpoch, after: cursor },
    )
    const initial = next.frames.find((frame) => frame.kind === "reset")!
    if (initial.kind !== "reset") throw new Error("Expected reset")
    expect(projection.receive(initial)).toBe(true)
    expect(projection.cursor?.after).toBe(initial.seq)
    await next.client.send(projection.acknowledgement()!)
    expect(await next.client.request("state.read", {})).toMatchObject({ status: "idle" })
    const live = f.runtime.journal.append({
      seq: 1,
      ts: 1,
      sessionId: "host",
      type: "ui.focus",
      data: { focused: true },
    })
    await eventually(() => next.frames.some((frame) => frame.kind === "event" && frame.seq === live.seq))
    for (const frame of next.frames) if (frame.kind === "event") projection.receive(frame)
    expect(projection.cursor?.after).toBe(live.seq)
    expect(projection.acknowledgement()!.seq).toBeLessThanOrEqual(f.runtime.journal.watermark)
    await next.client.send(projection.acknowledgement()!)
    expect(await next.client.request("state.read", {})).toMatchObject({ status: "idle" })
  } finally {
    await f.close()
  }
}, 15_000)

test("fast-mode control state advances the journal and converges live and cursor-only reconnects", async () => {
  const f = await fixture()
  try {
    const first = f.connect()
    const welcome = await first.client.ready
    await eventually(() => first.frames.some((frame) => frame.kind === "reset"))
    await Bun.sleep(0)
    const before = f.runtime.journal.watermark
    expect(
      (f.runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot).semantic.status.info.fastMode
        ?.requested,
    ).toBe(false)
    await first.client.request("fastMode.set", { enabled: true })
    await Bun.sleep(0)
    expect(f.runtime.journal.watermark).toBeGreaterThan(before)
    const representsFastMode = (frame: RemoteMessage) =>
      frame.kind === "event" && JSON.stringify(frame.payload).includes('"requested":true')
    await eventually(() => first.frames.some(representsFastMode))
    const next = f.connect(resume(welcome, before))
    await next.client.ready
    await eventually(() => next.frames.some(representsFastMode))
    expect(next.frames.some((frame) => frame.kind === "reset")).toBe(false)
    expect(
      (f.runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot).semantic.status.info.fastMode
        ?.requested,
    ).toBe(true)
  } finally {
    await f.close()
  }
}, 15_000)
