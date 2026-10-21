import "../server/offline.ts"
import { expect, test } from "bun:test"
import { RemoteAgentPort } from "../../src/remote/agent-port.ts"
import { createRemoteOverlayBackend } from "../../src/remote/agent-port-requests.ts"
import { RemoteConnection } from "../../src/remote/connection.ts"
import type { RemoteJson, RemoteMessage } from "../../src/remote/protocol.ts"
import { until } from "./agent-port-fixture.ts"
import { hello, loopback, welcome } from "./loopback.ts"
import { operationFixtures, snapshot } from "./schema-fixtures.ts"

function codecPort() {
  const workspace = {
    frontend: snapshot,
    semantic: { status: operationFixtures["status.read"].result, models: [], subagents: [], groups: [] },
    pendingRequests: [],
    startupEvents: [],
    activity: { events: [] },
    owners: {},
    jobs: [],
  }
  let server!: RemoteConnection
  let after = 0
  const frames: RemoteMessage[] = []
  const port = new RemoteAgentPort({
    hello,
    async connect() {
      const io = loopback(19)
      server = new RemoteConnection(io.server, {
        handshake: {
          role: "server",
          accept(value) {
            after = value.resume?.after ?? 0
            frames.push(value)
            return { ...welcome, controllerToken: "controller-token" }
          },
        },
        onMessage: (message) => {
          frames.push(message)
        },
        handle: async (request): Promise<RemoteJson> =>
          request.op.startsWith("ui.")
            ? { status: "accepted" }
            : request.op === "state.read"
              ? snapshot.state
              : { sessionGeneration: 1 },
      })
      void server.ready.then(() =>
        server.send({
          v: 1,
          kind: "reset",
          daemonEpoch: welcome.daemonEpoch,
          seq: after,
          reason: "fresh",
          snapshot: workspace,
        }),
      )
      return io.client
    },
  })
  return {
    port,
    frames,
    workspace,
    send: (message: Parameters<RemoteConnection["send"]>[0]) => server.send(message),
    close: async () => {
      await port.detach()
      server.close()
    },
  }
}

test("codec port acks only applied frames, fences old resets, and reconnects with its controller cursor", async () => {
  const f = codecPort()
  try {
    await f.port.reconnect()
    const events: { replay: boolean; seq: number }[] = []
    f.port.subscribeEvents((_event, context) => {
      events.push(context)
    })
    const event: RemoteJson = { seq: 1, ts: 1, sessionId: "s1", type: "ui.focus", data: { focused: true } }
    await f.send({
      v: 1,
      kind: "event",
      daemonEpoch: welcome.daemonEpoch,
      seq: 1,
      replay: true,
      payload: event,
    })
    await until(() => f.port.cursor?.after === 1)
    expect(events).toEqual([{ replay: true, seq: 1 }])
    await f.send({ v: 1, kind: "event", daemonEpoch: welcome.daemonEpoch, seq: 1, payload: event })
    let resets = 0
    f.port.subscribeReset(() => {
      resets++
    })
    await f.send({
      v: 1,
      kind: "reset",
      daemonEpoch: welcome.daemonEpoch,
      seq: 0,
      reason: "fresh",
      snapshot: f.workspace,
    })
    await Bun.sleep(10)
    expect(resets).toBe(0)
    expect(events).toHaveLength(1)
    await f.port.reconnect()
    expect(f.frames.filter((frame) => frame.kind === "hello").at(-1)).toMatchObject({
      resume: { daemonEpoch: welcome.daemonEpoch, after: 1, controllerToken: "controller-token" },
      snapshot: false,
    })
    expect(f.port.status).toBe("connected")
    await until(() => f.frames.some((frame) => frame.kind === "ack" && frame.seq === 1))
  } finally {
    await f.close()
  }
})

test("a replay gap closes the attachment without advancing its cursor and forces the next snapshot", async () => {
  const f = codecPort()
  try {
    await f.port.reconnect()
    await f.send({
      v: 1,
      kind: "event",
      daemonEpoch: welcome.daemonEpoch,
      seq: 2,
      payload: { seq: 1, ts: 1, sessionId: "s1", type: "ui.focus", data: { focused: true } },
    })
    await until(() => f.port.status === "disconnected")
    expect(f.port.cursor?.after).toBe(0)
    await f.port.reconnect()
    expect(f.frames.filter((frame) => frame.kind === "hello").at(-1)).toMatchObject({ snapshot: true })
  } finally {
    await f.close()
  }
})

test("renderer exceptions do not poison replay, and malformed execute params reject asynchronously", async () => {
  const f = codecPort()
  try {
    await f.port.reconnect()
    f.port.subscribeEvents(() => {
      throw new Error("renderer failed")
    })
    await f.send({
      v: 1,
      kind: "event",
      daemonEpoch: welcome.daemonEpoch,
      seq: 1,
      payload: { seq: 1, ts: 1, sessionId: "s1", type: "ui.focus", data: { focused: true } },
    })
    await until(() => f.port.cursor?.after === 1)
    expect(f.port.status).toBe("connected")
    await expect(f.port.execute("turn.prompt", { message: Number.NaN as never })).rejects.toThrow()
    expect(await f.port.execute("turn.abort", { turnId: undefined })).toEqual({ sessionGeneration: 1 })
  } finally {
    await f.close()
  }
})

test("projection failure preserves the last good snapshot and rejects reads until recovery", async () => {
  const f = codecPort()
  try {
    await f.port.reconnect()
    const original = f.port.snapshot
    await f.send({
      v: 1,
      kind: "event",
      daemonEpoch: welcome.daemonEpoch,
      seq: 1,
      payload: { kind: "error", error: { code: "invalid_snapshot", message: "Projection unavailable" } },
    })
    await until(() => f.port.cursor?.after === 1)
    expect(f.port.snapshot).toBe(original)
    await expect(f.port.execute("state.read", {})).rejects.toMatchObject({ code: "invalid_snapshot" })
    await f.send({
      v: 1,
      kind: "event",
      daemonEpoch: welcome.daemonEpoch,
      seq: 2,
      payload: { kind: "snapshot", snapshot },
    })
    await until(() => f.port.cursor?.after === 2)
    expect(await f.port.execute("state.read", {})).toEqual(snapshot.state)
  } finally {
    await f.close()
  }
})

test("overlay answers use asynchronous host operations and wait for authoritative resolution", async () => {
  const f = codecPort()
  try {
    await f.port.reconnect()
    const backend = createRemoteOverlayBackend(f.port)
    try {
      expect(backend.requestState("dialog")).toBe("unknown")
      await f.send({
        v: 1,
        kind: "event",
        daemonEpoch: welcome.daemonEpoch,
        seq: 1,
        payload: {
          seq: 1,
          ts: 1,
          sessionId: "s1",
          type: "ui.request",
          data: { kind: "confirm", requestId: "dialog", title: "Confirm" },
        },
      })
      await until(() => f.port.pendingRequests.length === 1)
      expect(backend.requestState("dialog")).toBe("pending")
      expect(await backend.respond("dialog", true)).toEqual({ status: "accepted" })
      expect(backend.requestState("dialog")).toBe("pending")
      await f.send({
        v: 1,
        kind: "event",
        daemonEpoch: welcome.daemonEpoch,
        seq: 2,
        payload: {
          seq: 2,
          ts: 2,
          sessionId: "s1",
          type: "ui.resolved",
          data: { requestId: "dialog", cancelled: false, value: true },
        },
      })
      await until(() => f.port.pendingRequests.length === 0)
      expect(backend.requestState("dialog")).toBe("settled")
    } finally {
      backend.dispose()
    }
  } finally {
    await f.close()
  }
})
